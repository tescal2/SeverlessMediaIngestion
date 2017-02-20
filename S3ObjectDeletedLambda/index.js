#!/usr/bin/env node

var path = require('path');

var aws = require('aws-sdk');
var async = require('async');

function deleteDbItem(tableName, id, cbk) {
    new aws.DynamoDB.DocumentClient().delete({
        TableName: tableName,
        Key: {
            id: id
        }
    }, cbk);
}

function deleteS3Objects(bucketName, prefix, startAfter, callback) {
    console.log("Listing objects in", bucketName, "with prefix", prefix);
    var s3 = new aws.S3();
    s3.listObjectsV2({
        Bucket: bucketName,
        Prefix: prefix,
        StartAfter: startAfter
    }, function (err, data) {
        if (err) {
            callback(err);
        } else {
            var objects = data.Contents;
            var objectsCount = objects.length;
            console.log(objectsCount, "objects found in listing");
            if (objectsCount == 0) {
                callback();
            } else {
                var startAfter = data.StartAfter;
                s3.deleteObjects({
                    Bucket: bucketName,
                    Delete: {
                        Objects: objects.map(function (o) {
                            return {
                                Key: o.Key
                            };
                        })
                    }
                }, function (err, data) {
                    if (err) {
                        callback(err);
                    } else if (startAfter) {
                        deleteS3Objects(bucketName, prefix, startAfter, callback);
                    } else {
                        callback();
                    }
                });
            }
        }
    });
}

exports.handler = function (evt, ctx) {
    console.log('event: ', JSON.stringify(evt));
    async.each(evt.Records, function (record, cbk) {
        var s3Record = record.s3;
        var config = JSON.parse(s3Record.configurationId);
        console.log('Config is', config);
        var object = s3Record.object;
        var key = decodeURIComponent(object.key.replace(/\+/g, " "));
        var bucket = s3Record.bucket.name;
        var extension = path.extname(key);
        var id = path.basename(key.substring(config.keyPrefix.length), extension);
        console.log('Key ', key, ' id ', id, ' extension ', extension);
        async.waterfall([
            function (cbk) {
                deleteDbItem(config.tableName, id, cbk);
            },
            function (res, cbk) {
                deleteS3Objects(bucket, 'outputs/' + id, null, cbk);
            }
        ], cbk);
    }, function (err) {
        ctx.done(err, err ? 'Failed to process S3 Object Deleted events' : 'Processed S3 Object Deleted events');
    });
};