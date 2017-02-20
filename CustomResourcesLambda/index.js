#!/usr/bin/env node

var https = require('https');
var url = require('url');
var async = require('async');
var aws = require('aws-sdk');

var cfnResponse = require('./cfn-response.js');

var s3 = new aws.S3();
var et = new aws.ElasticTranscoder();
var cf = new aws.CloudFront();

function findPipelineByName(name, cbk) {
    console.log('Finding ET pipeline named ' + name);
    var params = {};
    async.doWhilst(function (cbk) {
        et.listPipelines(params, function (err, dat) {
            if (err) cbk(err);
            else {
                console.log('Pipelines page: ', JSON.stringify(dat));
                var pipelines = dat.Pipelines;
                for (var i = 0; i < pipelines.length; i++) {
                    var pipeline = pipelines[i];
                    if (pipeline.Name === name) {
                        console.log('Pipeline ', name, ' has id ', pipeline.Id);
                        delete params.PageToken;
                        cbk(null, pipeline);
                        return;
                    }
                }
                console.log('Pipeline ', name, ' not found in page');
                params.PageToken = dat.NextPageToken;
                cbk();
            }
        })
    }, function () { return params.PageToken; }, function (err, dat) {
        if (err) console.error('Error finding pipeline ' + name);
        else if (dat) console.log('Pipeline ', name, ' found with id ', dat.Id);
        else console.log('Pipeline ', name, ' not found');
        cbk(err, dat);
    });
}
function callbackWithPipelineData(err, data, physicalResourceId, cbk) {
    if (err) {
        console.error('Error on callback getting pipeline data', err);
    } else {
        var pipeline = data.Pipeline;
        data = { Name: physicalResourceId };
        if (pipeline) {
            data.Id = pipeline.Id;
            data.Arn = pipeline.Arn;
        }
    }
    cbk(err, data);
}
function createPipeline(event, physicalResourceId, cbk) {
    var props = event.ResourceProperties;
    var params = {
        Name: physicalResourceId,
        InputBucket: props.InputBucket,
        OutputBucket: props.OutputBucket,
        Role: props.RoleArn,
        Notifications: {
            Completed: props.CompletedTopicArn,
            Error: '',
            Warning: '',
            Progressing: ''
        }
    };
    console.log('Creating Elastic Transcoder pipeline', JSON.stringify(params));
    et.createPipeline(params, function (err, dat) {
        callbackWithPipelineData(err, dat, physicalResourceId, cbk);
    });
}
function deletePipeline(event, physicalResourceId, cbk) {
    console.log('Deleting Elastic Transcoder pipeline ', physicalResourceId);
    async.waterfall([
        function (cbk) { findPipelineByName(physicalResourceId, cbk); },
        function (dat, cbk) {
            if (dat) {
                et.deletePipeline({
                    Id: dat.Id
                }, cbk);
            } else {
                cbk();
            }
        }
    ], function (err, dat) {
        callbackWithPipelineData(err, dat, physicalResourceId, cbk);
    });
}


function addBucketNotificationConfiguration(notificationConfiguration, physicalResourceId, props) {
    if (!notificationConfiguration) {
        notificationConfiguration = {};
    }
    var lambdaFunctionConfigurations = notificationConfiguration.LambdaFunctionConfigurations;
    if (!lambdaFunctionConfigurations) {
        lambdaFunctionConfigurations = notificationConfiguration.LambdaFunctionConfigurations = [];
    }
    var id = {
        id: physicalResourceId,
        keyPrefix: props.KeyPrefix
    };
    var functionArgs = props.FunctionArgs;
    for (var key in functionArgs) {
        id[key[0].toLowerCase() + key.substring(1)] = functionArgs[key];
    }
    lambdaFunctionConfigurations.push({
        Events: props.Events,
        LambdaFunctionArn: props.FunctionArn,
        Filter: {
            Key: {
                FilterRules: [
                    {
                        Name: 'prefix',
                        Value: props.KeyPrefix
                    }
                ]
            }
        },
        Id: JSON.stringify(id)
    })
    return notificationConfiguration;
}
function removeBucketNotificationConfiguration(notificationConfiguration, physicalResourceId) {
    if (notificationConfiguration) {
        var lambdaConfigurations = notificationConfiguration.LambdaFunctionConfigurations;
        if (lambdaConfigurations) {
            for (var i = 0; i < lambdaConfigurations.length; i++) {
                var config;
                try {
                    config = JSON.parse(lambdaConfigurations[i].Id);
                } catch (err) {
                    continue;
                }
                if (config.id === physicalResourceId) {
                    lambdaConfigurations.splice(i, 1);
                    break;
                }
            }
        }
    }
}
function getBucketNotificationConfiguration(bucket, cbk) {
    s3.getBucketNotificationConfiguration({ Bucket: bucket }, cbk);
}
function putBucketNotificationConfiguration(bucket, notificationConfiguration, cbk) {
    var params = {
        Bucket: bucket,
        NotificationConfiguration: notificationConfiguration
    };
    console.log('Putting bucket notification configuration: ', JSON.stringify(params));
    s3.putBucketNotificationConfiguration(params, function (err, dat) {
        if (err) {
            console.error('Error putting bucket notification configuration: ', JSON.stringify(err));
        } else {
            console.log('Put bucket notification configuration: ', JSON.stringify(dat));
        }
        cbk(err, dat);
    });
}


function callbackWithOriginAccessIdentityData(err, data, physicalResourceId, cbk) {
    if (err) {
        console.error('Error on callback getting Origin Access Identity data', err);
    } else {
        var oai = data.CloudFrontOriginAccessIdentity;
        data = { Name: physicalResourceId };
        if (oai) {
            data.Id = oai.Id;
            S3CanonicalUserId = oai.S3CanonicalUserId;
        }
    }
    cbk(err, data);
}
function findOriginAccessIdentityByPhysicalResourceId(physicalResourceId, cbk) {
    console.log('Finding Origin Access Identity with physical resource id', physicalResourceId);
    var params = {};
    async.doWhilst(function (cbk) {
        cf.listCloudFrontOriginAccessIdentities(params, function (err, dat) {
            if (err) {
                cbk(err);
            } else {
                console.log('Origin Access Identities page: ', JSON.stringify(dat));
                var items = dat.CloudFrontOriginAccessIdentityList.Items;
                for (var i = 0; i < items.length; i++) {
                    var item = items[i];
                    if (item.Comment === physicalResourceId) {
                        console.log('Origin Access Identity ', physicalResourceId, ' has id ', item.Id);
                        delete params.PageToken;
                        cbk(null, item);
                        return;
                    }
                }
                console.log('Origin Access Identity ', physicalResourceId, ' not found in page');
                params.PageToken = dat.NextPageToken;
                cbk();
            }
        })
    }, function () {
        return params.PageToken;
    }, function (err, dat) {
        if (err) {
            console.error('Error finding Origin Access Identity ' + physicalResourceId);
        } else if (dat) {
            console.log('Origin Access Identity ', physicalResourceId, ' found with id ', dat.Id);
        } else {
            console.log('Origin Access Identity ', physicalResourceId, ' not found');
        }
        cbk(err, dat);
    });
}
function createOriginAccessIdentity(physicalResourceId, cbk) {
    cf.createCloudFrontOriginAccessIdentity({
        CloudFrontOriginAccessIdentityConfig: {
            CallerReference: physicalResourceId,
            Comment: physicalResourceId
        }
    }, function (err, data) {
        callbackWithOriginAccessIdentityData(err, data, physicalResourceId, cbk);
    });
}
function deleteOriginAccessIdentity(physicalResourceId, cbk) {
    async.waterfall([
        function (cbk) {
            findOriginAccessIdentityByPhysicalResourceId(physicalResourceId, cbk);
        },
        function (res, cbk) {
            cf.getCloudFrontOriginAccessIdentity({
                Id: res.Id
            }, cbk)
        },
        function (res, cbk) {
            cf.deleteCloudFrontOriginAccessIdentity({
                Id: res.CloudFrontOriginAccessIdentity.Id,
                IfMatch: res.ETag,
            }, cbk);
        }
    ], function (err, res) {
        callbackWithOriginAccessIdentityData(err, res, physicalResourceId, cbk);
    });
}


var handlers = {
    'Custom::ElasticTranscoderPipeline': {
        'Create': createPipeline,
        'Update': function (event, physicalResourceId, cbk) {
            console.log('Updating Elastic Transcoder pipeline ', physicalResourceId);
            async.waterfall([
                function (cbk) {
                    deletePipeline(event, cbk);
                },
                function (dat, cbk) {
                    createPipeline(event, cbk);
                }
            ], function (err, dat) {
                callbackWithPipelineData(err, dat, physicalResourceId, cbk);
            });
        },
        'Delete': deletePipeline
    },
    'Custom::S3BucketNotification': {
        'Create': function (event, physicalResourceId, cbk) {
            var props = event.ResourceProperties;
            var bucket = props.Bucket;
            async.waterfall([
                function (cbk) {
                    getBucketNotificationConfiguration(bucket, cbk);
                },
                function (dat, cbk) {
                    dat = addBucketNotificationConfiguration(dat, physicalResourceId, props);
                    putBucketNotificationConfiguration(bucket, dat, cbk);
                }
            ], cbk);
        },
        'Update': function (event, physicalResourceId, cbk) {
            var props = event.ResourceProperties;
            var bucket = props.Bucket;
            async.waterfall([
                function (cbk) {
                    getBucketNotificationConfiguration(bucket, cbk);
                },
                function (dat, cbk) {
                    removeBucketNotificationConfiguration(dat, physicalResourceId);
                    dat = addBucketNotificationConfiguration(dat, physicalResourceId, props);
                    putBucketNotificationConfiguration(bucket, dat, cbk);
                }
            ], cbk);
        },
        'Delete': function (event, physicalResourceId, cbk) {
            var props = event.ResourceProperties;
            var bucket = props.Bucket;
            async.waterfall([
                function (cbk) {
                    getBucketNotificationConfiguration(bucket, cbk);
                },
                function (dat, cbk) {
                    removeBucketNotificationConfiguration(dat, physicalResourceId);
                    putBucketNotificationConfiguration(bucket, dat, cbk);
                }
            ], cbk);
        }
    },
    'Custom::CloudFrontOriginAccessIdentity': {
        'Create': function (event, physicalResourceId, cbk) {
            var props = event.ResourceProperties;
            createOriginAccessIdentity(physicalResourceId, cbk);
        },
        'Update': function (event, physicalResourceId, cbk) {
            //nothing to do
        },
        'Delete': function (event, physicalResourceId, cbk) {
            var props = event.ResourceProperties;
            deleteOriginAccessIdentity(physicalResourceId, cbk);
        }
    }
}

exports.handler = function (evt, ctx) {
    console.log('Event: ', JSON.stringify(evt));
    var requestType = evt.RequestType;
    var resourceType = evt.ResourceType;
    var cbk = function (err, dat) {
        if (err) {
            console.error('Performing ', requestType, ' on ', resourceType, ' failed: ', JSON.stringify(err));
        } else {
            console.log('Performing ', requestType, ' on ', resourceType, ' succeeded');
        }
        cfnResponse.send(evt, ctx, cfnResponse[err ? 'FAILED' : 'SUCCESS'], dat);
    };
    if ((requestType === 'Update') && (JSON.stringify(evt.OldResourceProperties) === JSON.stringify(evt.ResourceProperties))) {
        console.log('Update not required'); //do I need to re-send outputs?
        cbk();
    }
    else {
        var physicalResourceId = /^arn:aws:cloudformation:[^:]*:[^:]*:stack\/([^/]*)\/.*$/.exec(evt.StackId)[1] + '-' + evt.LogicalResourceId;
        handlers[resourceType][requestType](evt, physicalResourceId, cbk);
    }
};