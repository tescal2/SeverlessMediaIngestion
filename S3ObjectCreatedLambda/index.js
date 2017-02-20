#!/usr/bin/env node

process.env['PATH'] = process.env['PATH'] + ':' + process.env['LAMBDA_TASK_ROOT'];

var path = require('path');


var aws = require('aws-sdk');
var async = require('async');

var fullInfo = false;
var outputs = [
    { PresetId: '1351620000001-200010', Key: '2000-', SegmentDuration: '10' },
    { PresetId: '1351620000001-200020', Key: '1500-', SegmentDuration: '10' },
    { PresetId: '1351620000001-200030', Key: '1000-', SegmentDuration: '10' },
    { PresetId: '1351620000001-200040', Key: '600-', SegmentDuration: '10' },
    { PresetId: '1351620000001-200050', Key: '400-', SegmentDuration: '10' }
];

const env = process.env;
const tableName = 'octankpoc1';
const keyPrefix = env.KeyPrefix;
const pipelineId = '1485824934421-zmtoe9';


function putDbItem(tableName, id, extension, createdDate, objectSize, eTag, versionId, cbk) {
    const params = {
        TableName: tableName,
        Item: {
            id: id,
            extension: extension,
            created: createdDate.toISOString(),
            size: objectSize,
            eTag: eTag,
            versionId: versionId,
                    }
    };
    console.log("Putting database item...");
    new aws.DynamoDB.DocumentClient().put(params, (err, res) => {
        if (err) {
            console.error("Unable to put item", err);
        } else {
            console.log('Item put into database');
        }
        cbk(err);
    });
}

function createETJob(key, pipelineId, keyPrefix, tableName, cbk) {
    const outputKey = path.basename(key, path.extname(key));
    const params = {
        Input: { Key: key },
        PipelineId: pipelineId,
        OutputKeyPrefix: 'outputs/' + outputKey + '/',
        Outputs: outputs,
        Playlists: [
            {
                Format: 'HLSv3',
                Name: 'playlist',
                OutputKeys: outputs.map((o) => { return o.Key; })
            }
        ]
    };
    console.log('Job params ' + JSON.stringify(params));
    new aws.ElasticTranscoder().createJob(params, (err, res) => {
        if (err) {
            console.error('Error creating Elastic Transcoder job ' + err);
        } else {
            console.log('Created Elastic Transcoder Job ' + res);
        }
        cbk(err, res);
    });
}

exports.handler = (evt, ctx) => {
    console.log('event: ', JSON.stringify(evt));
    async.each(evt.Records, (record, cbk) => {
        const s3Record = record.s3;
        const object = s3Record.object;
        const key = decodeURIComponent(object.key.replace(/\+/g, " "));
        const objectSize = object.size;
        if (objectSize > 0) {
            const bucket = s3Record.bucket.name;
            const extension = path.extname(key);
            const id = path.basename(key.substring(keyPrefix), extension);
            console.log('Key ', key, ' id ', id, ' extension ', extension);
            const createdDate = new Date(record.eventTime);
            console.log('Created Date is', createdDate);
            async.waterfall([

                (res, cbk) => {
                    putDbItem(tableName, id, extension, createdDate, objectSize, object.eTag, object.versionId, res, cbk);
                },
                (cbk) => {
                    createETJob(key, pipelineId, keyPrefix, tableName, cbk);
                }
            ], cbk);
        }
        else {
            console.log('Object', key, 'has zero size');
            cbk();
        }
    }, (err) => {
        ctx.done(err, err ? 'Failed to process S3 Object Created events' : 'Processed S3 Object Created events');
    });
};