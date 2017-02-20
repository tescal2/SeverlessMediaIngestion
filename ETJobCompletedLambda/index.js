#!/usr/bin/env node

var aws = require('aws-sdk');
var path = require('path');

exports.handler = function (evt, ctx) {
    console.log('Elastic Transcoder Job Completed', JSON.stringify(evt));
    var sns = evt.Records[0].Sns;
    var transcoded = new Date(sns.Timestamp)
    console.log('Transcoded ', transcoded);
    var transcodeInfo = JSON.parse(sns.Message);
    console.log('Transcode Info', JSON.stringify(transcodeInfo));
    var userMetadata = transcodeInfo.userMetadata;
    var key = transcodeInfo.input.key;
    var extension = path.extname(key);
    var id = path.basename(key.substring(userMetadata.keyPrefix), extension);
    console.log(id, 'now transcoded');
    var duration = transcodeInfo.outputs[0].duration;
    new aws.DynamoDB.DocumentClient().update({
        TableName: 'octankpoc1',
        Key: { id: id },
        AttributeUpdates: {
            transcoded: {
                Action: 'PUT',
                Value: transcoded.toISOString()
            },
            transcodeInfo: {
                Action: 'PUT',
                Value: transcodeInfo
            }
        }
    }, function (err, res) {
        if (err) {
            console.log('Error updating database', err);
        } else {
            console.log('Updated database', res);
        }
        ctx.done(null, JSON.stringify(evt));
    });
};