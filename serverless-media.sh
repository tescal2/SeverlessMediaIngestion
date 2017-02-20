#!/usr/bin/env sh

COMMAND="$1"; shift
STACKNAME="$1"; shift

function zipAndUpload {
    local SRC="$1"
    local DST="$2"
    pushd "$SRC" > /dev/null
    zip -rq9 - . | aws s3 cp - "$DST"
    popd > /dev/null
}

function waitForStackReady {
    local STACKNAME="$1"
    echo "Waiting for Octank's $STACKNAME stack creation to be complete - this could take 15 minutes"
    local STATUS=$(aws cloudformation describe-stacks --stack-name "$STACKNAME" --query "Stacks[0].StackStatus" --output text)
    case "$STATUS" in
        CREATE_COMPLETE|UPDATE_COMPLETE)
            return 0
            ;;
        CREATE_IN_PROGRESS|UPDATE_IN_PROGRESS)
            local STATE="${STATUS:0:6}"
            STATE=$(echo "$STATE" | tr '[:upper:]' '[:lower:]')
            aws cloudformation wait "stack-$STATE-complete" --stack-name "$STACKNAME"
            if [ $? -eq 0 ] ;then
                return 0
            else
                return 1
            fi
            ;;
        *)
            return 1
    esac
}

function loadStackOutputs {
    local STACKNAME="$1"
    echo "Getting Stack Outputs for $STACKNAME"
    OUTPUTS=$(aws cloudformation describe-stacks --stack-name "$STACKNAME" --query "Stacks[0].Outputs[*][OutputKey,OutputValue]" --output text)
    if [ "$OUTPUTS" == "None" ] ;then
        echo "There are no outputs."
    else
        local OLDIFS=$IFS
        IFS=$'\n'
        OUTPUTS=($OUTPUTS)
        local COUNT=${#OUTPUTS[@]}
        echo "There are $COUNT outputs"
        local OUTPUT
        for OUTPUT in ${OUTPUTS[@]} ;do 
            IFS=$'\t'
            OUTPUT=($OUTPUT)
            local KEY="${OUTPUT[0]}"
            local VALUE="${OUTPUT[1]}"
            printf -v "STACKOUTPUT_$KEY" %s "$VALUE"
            echo "\t${KEY} = $VALUE"
        done
        IFS=$OLDIFS
    fi
}

function getStackOutput {
    local NAME="$1"
    NAME="STACKOUTPUT_${NAME}"
    local VAL="${!NAME}"
    echo "$VAL"
}

function uploadWebsite {
    local STACKNAME="$1"
    loadStackOutputs "$STACKNAME"
    BUCKETNAME=$(getStackOutput "S3BucketName")
    TABLENAME=$(getStackOutput "DBTableName")
    JSONFILE="./Website/html/config.json"
    INPUTJSON=$(cat "$JSONFILE")
    OUTPUTJSON=$(echo $INPUTJSON | jq ".s3.bucket.name=\"$BUCKETNAME\"|.dynamoDB.table.name=\"$TABLENAME\"")
    echo "Changing config.json from $INPUTJSON to $OUTPUTJSON"
    echo "$OUTPUTJSON" > "$JSONFILE"

    echo "Uploading Website to $BUCKETNAME"
    aws s3 cp "./Website" "s3://$BUCKETNAME/" --recursive

    invalidateCache
}

function invalidateCache {
    DISTRIBUTIONID=$(getStackOutput "CFDistributionId")
    echo "Invalidating CloudFront Distribution $DISTRIBUTIONID..."
    INVALIDATIONID=$(aws cloudfront create-invalidation --distribution-id "$DISTRIBUTIONID" --paths "/*" --query "Invalidation.Id" --output text)
    echo "Waiting for Invalidation $INVALIDATIONID to complete..."
    aws cloudfront wait invalidation-completed --distribution-id "$DISTRIBUTIONID" --id "$INVALIDATIONID"
    echo "Invalidation $INVALIDATIONID complete"
}

function getLambdasFromDir {
    LAMBDANAMES=()
    local DIR
    for DIR in *Lambda/ ;do
        LAMBDANAMES+=($(basename $DIR))
    done
    reportLambdas "from directory"
}

function getLambdasFromOutputs {
    local VARNAME
    LAMBDANAMES=()
    for VARNAME in ${!STACKOUTPUT_*} ;do
        if [[ $VARNAME =~ STACKOUTPUT_(.*)LambdaArn ]] ;then
            LAMBDANAMES+=("${BASH_REMATCH[1]}")
        fi
    done
    reportLambdas "from stack outputs"
}

function reportLambdas {
    local COUNT=${#LAMBDANAMES[@]}
    echo "There are $COUNT lambdas $1"
    for NAME in ${LAMBDANAMES[@]} ;do
        echo "\t$NAME"
    done
}

function updateLambda {
    local BUCKETNAME="$1"
    local LAMBDANAME="$2"
    if [ -z "$LAMBDANAME" ] ;then
        getLambdasFromOutputs
        for NAME in ${LAMBDANAMES[@]} ;do
            updateLambda "$BUCKETNAME" "$NAME"
        done
    else
        NAME="${LAMBDANAME}Lambda"
        SRC="./$NAME/"
        DST="s3://$BUCKETNAME/$NAME.zip"
        echo "Zipping and uploading $SRC to $DST..."
        # An improvement to this would be:
        # 1) Zip the function.
        # 2) Checksum the zip.
        # 3) Compare with the current zip file on S3. If changed:
        #   a) Upload the zip (setting a metadata header to store the checksum). 
        #   b) Get the version ID.
        #   c) Update the template.
        #   d) Issue a stack update.
        zipAndUpload "$SRC" "$DST"
        ARN=$(getStackOutput "${NAME}Arn")
        if [ -z "$ARN" ]
        then
            echo "Output $OUTPUTNAME not found"
        else
            echo "Updating Lambda $NAME that has ARN $ARN with code s3://$BUCKETNAME/$NAME.zip"
            aws lambda update-function-code --function-name "$ARN" --s3-bucket "$BUCKETNAME" --s3-key "$NAME.zip"
        fi
    fi 
}

BUCKETNAME="yours3bucketname"
TEMPLATENAME="serverless-media.cfn.yaml"
CLIENTROLE="Cognito_OctankServerlessMediaAuth_Role"
HOSTEDZONENAME="yourhostedzone.com"
ACMCERTIFICATEARN="yourcertificatehere(arn:aws:acm:us-east-1:271724326820:certificate/1632c156-08c4-4d34-3e58-edf67fa5cde3)"
while getopts "b:t:r:z:c:l:" o ;do 
    case "${o}" in
        b)
            BUCKETNAME=${OPTARG}
            ;;
        t)
            TEMPLATENAME=${OPTARG}
            ;;
        r)
            CLIENTROLE=${OPTARG}
            ;;
        z)
            HOSTEDZONENAME=${OPTARG}
            ;;
        c)
            ACMCERTIFICATEARN=${OPTARG}
            ;;
        l)
            LAMBDANAME=${OPTARG}
            ;;
    esac
done

case "$COMMAND" in
    create-stack|update-stack)
        case "$COMMAND" in
            create-stack)
                ACTION="Creating"
                ;;
            update-stack)
                ACTION="Updating"
                ;;
        esac
        
        getLambdasFromDir
        
        for NAME in ${LAMBDANAMES[@]} ;do
            SRC="./$NAME/"
            DST="s3://$BUCKETNAME/$NAME.zip"
            echo "Zipping and uploading $SRC to $DST..."
            zipAndUpload "$SRC" "$DST"
        done
        
        SRC="./$TEMPLATENAME"
        DST="s3://$BUCKETNAME/$TEMPLATENAME"
        echo "Uploading template $SRC to $DST ..."
        aws s3 cp "$SRC" "$DST"

        URL="https://s3.amazonaws.com/$BUCKETNAME/$TEMPLATENAME"
        PARAMETERS="ParameterKey=CodeBucketName,ParameterValue=$BUCKETNAME ParameterKey=ClientRoleName,ParameterValue=$CLIENTROLE ParameterKey=HostedZoneName,ParameterValue=$HOSTEDZONENAME ParameterKey=AcmCertificateArn,ParameterValue=$ACMCERTIFICATEARN"
        echo "$ACTION Stack $STACKNAME with $PARAMETERS ..."
        aws cloudformation "$COMMAND" --stack-name "$STACKNAME" --template-url "$URL" --parameters $PARAMETERS --capabilities "CAPABILITY_IAM"

        waitForStackReady "$STACKNAME"
        if [ $? -eq 0 ] ;then
            uploadWebsite "$STACKNAME"
        else 
            echo "Stack $STACKNAME not ready"
        fi
        ;;
    delete-stack)
        loadStackOutputs "$STACKNAME"
        BUCKETNAME=$(getStackOutput "S3BucketName")

        echo "Emptying $BUCKETNAME"
        aws s3 rm "s3://$BUCKETNAME" --recursive

        echo "Deleting Stack $STACKNAME"
        aws cloudformation delete-stack --stack-name "$STACKNAME"
        ;;
    upload-website)
        waitForStackReady "$STACKNAME"
        uploadWebsite "$STACKNAME"
        ;;
    invalidate-cache)
        waitForStackReady "$STACKNAME"
        loadStackOutputs "$STACKNAME"
        invalidateCache
        ;;
    update-lambda)
        waitForStackReady "$STACKNAME"
        if [ $? -eq 0 ] ;then
            loadStackOutputs "$STACKNAME"
            BUCKETNAME=$(getStackOutput "S3BucketName")
            updateLambda "$BUCKETNAME" "$LAMBDANAME"
        else 
            echo "Stack $STACKNAME creation not complete"
        fi
        ;;    
    *)
        echo $"Usage:
$0 {create-stack|update-stack} <stack-name> -b <bucket-name> -t <template-name> -r <client-role> -z <hosted-zone-name> -c <acm-certificate-arn>
$0 delete-stack <stack-name>"
        exit 1
esac

