
function show(element) {
    element.classList.remove('hidden');
}
function hide(element) {
    element.classList.add('hidden');
}
window.addEventListener('load', function (evt) {
    var configRequest = new XMLHttpRequest();
    configRequest.open('GET', './html/config.json');
    configRequest.responseType = 'json';
    configRequest.addEventListener('load', function (evt) {
        var config = evt.target.response;
        console.log('Config loaded', JSON.stringify(config));
        var loginButton = document.getElementById('loginButton');
        var loginLabel = loginButton.lastChild;
        var mediaContainer = document.getElementById('mediaContainer');

        var liveSection = document.getElementById('liveSection');
        var livePlayer = document.getElementById('livePlayer');
        var recordForm = document.getElementById('recordForm');
        var recordKey = document.getElementById('recordKey');
        var recordButton = document.getElementById('recordButton');
        var recordButtonClassList = recordButton.classList;
        var progressBar = document.getElementById('progressBar');
        var progressBarParent = progressBar.parentNode;

        var transcodedSection = document.getElementById('transcodedSection');
        var refreshButton = document.getElementById('refreshButton');
        var mediaList = document.getElementById('mediaList');
        var mediaJSON = document.getElementById('mediaJSON');


        console.log(config.cognito);

        if (AWS) {
            var awsConfig = AWS.config;
            if (awsConfig) {
                awsConfig.region = 'us-east-1';
                var tokens = {};
                var identityPoolConfig = config.cognito.identityPool;
                function getCognitoCredentials(cbk) {
                    var params = {
                        IdentityPoolId: identityPoolConfig.id
                    };
                    if (tokens) {
                        params.Logins = tokens;
                    }
                    awsConfig.credentials = new AWS.CognitoIdentityCredentials(params);
                    var credentials = awsConfig.credentials;
                    credentials.get(function (err) {
                        if (err) {
                            console.error('Error getting credentials ' + err);
                        }
                        cbk();
                    });
                }
                if (amazon) {
                    var amazonLogin = amazon.Login;
                    if (amazonLogin) {
                        amazonLogin.setClientId(identityPoolConfig.identityProviders.amazon.client.id);
                        amazonLogin.setUseCookie(true);
                        function login(interactive) {
                            amazonLogin.authorize({
                                'scope': 'profile',
                                'interactive': interactive ? 'auto' : 'never'
                            }, function (response) {
                                if (response.error) {
                                    prepareForLogin();
                                } else {
                                    tokens['www.amazon.com'] = response.access_token;
                                    amazonLogin.retrieveProfile(tokens['www.amazon.com'], function (response) {
                                        var profile = response.profile;
                                        setLoginLabel('Logout as ' + profile.Name);
                                        getCognitoCredentials(function () {
                                            showMediaContainer();
                                        });
                                    });
                                }
                            });
                        }
                        function setLoginLabel(text) {
                            loginLabel.innerHTML = text;
                            if (text) {
                                show(loginButton);
                            } else {
                                hide(loginButton);
                            }
                        }
                        function prepareForLogin() {
                            delete tokens['www.amazon.com'];
                            setLoginLabel('Login with Amazon');
                            hideMediaContainer();
                        }
                        function logout() {
                            amazonLogin.logout();
                            prepareForLogin();
                        }
                        loginButton.addEventListener('click', function (evt) {
                            if (tokens['www.amazon.com']) {
                                logout();
                            } else {
                                login(true);
                            }
                            evt.preventDefault();
                        });
                        login(false);

                        livePlayer.addEventListener('play', function () {
                            console.log('Live player has started');
                            recordButton.disabled = false;
                        })
                        livePlayer.addEventListener('ended', function () {
                            console.log('Live player has ended');
                            recordButton.disabled = true;
                        })
                        function setProgress(value) {
                            progressBar.style.width = value + '%';
                            progressBar.setAttribute('aria-valuenow', 0);
                            if ((value <= 0) || (value >= 100)) {
                                hide(progressBarParent);
                            }
                            else {
                                show(progressBarParent);
                            }
                        }
                        var recorder;
                        var contentType = 'video/mp4';
                        var fileExtension = '.mp4';
                        var s3BucketConfig = config.s3.bucket;
                        
                        recordForm.addEventListener('submit', function (evt) {
                            if (recorder && (recorder.state == 'recording')) {
                                stopVideo();
                            } else {
                                startVideo();
                            }
                            evt.preventDefault();
                        });
                        function recorderDataAvailable(e) {
                            var blob = e.data;
                            var key = s3BucketConfig.inputs.prefix + recordKey.value + fileExtension;
                            console.log('Uploading video as ' + key);

                            var upload = new AWS.S3.ManagedUpload({
                                params: {
                                    Bucket: s3BucketConfig.name,
                                    Key: key,
                                    ContentType: contentType,
                                    Body: blob
                                }
                            });
                            setProgress(0);
                            upload.on('httpUploadProgress', function (evt) {
                                setProgress((evt.loaded * 100) / evt.total);
                            });
                            upload.send(function (err, data) {
                                if (err) {
                                    console.log(err, err.stack);
                                    setProgress(0);
                                } else {
                                    console.log('Uploaded', data);
                                    setProgress(100);
                                }
                            });
                        }

                        function startVideo() {
                            if (recorder) {
                                recorder.start();
                            }
                            recordButtonClassList.remove('fa-play-circle');
                            recordButtonClassList.add('fa-stop-circle');
                        }
                        function stopVideo() {
                            if (recorder) {
                                recorder.stop();
                            }
                            recordButtonClassList.remove('fa-stop-circle');
                            recordButtonClassList.add('fa-play-circle');
                        }
                        var mediaStream;
                        function showMediaContainer() {
                            navigator.mediaDevices.getUserMedia({
                                audio: true,
                                video: true
                            }).then(function (stream) {
                                mediaStream = stream;
                                livePlayer.src = URL.createObjectURL(mediaStream);
                                livePlayer.play();
                                var mediaRecorderOptions = {
                                    audioBitsPerSecond: 128000,
                                    videoBitsPerSecond: 2500000
                                };
                                if (MediaRecorder.canRecordMimeType) {
                                    var canRecordContentType = MediaRecorder.canRecordMimeType(contentType);
                                    console.log('MediaRecorder can record', contentType, ' = ', canRecordContentType);
                                    if (canRecordContentType) {
                                        mediaRecorderOptions.mimeType = contentType;
                                    }
                                } else {
                                    console.log('Live Test if MediaRecorder can record: SUCCESS!', contentType); // Message should be Unable to test if MediaRecorder can record
                                }
                                recorder = new MediaRecorder(mediaStream, mediaRecorderOptions);
                                console.log('MediaRecorder will record', recorder.mimeType);
                                recorder.addEventListener('dataavailable', recorderDataAvailable);
                                loadMediaList();
                                show(mediaContainer);
                            });
                        }
                        function hideMediaContainer() {
                            hide(mediaContainer);
                            if (recorder) {
                                recorder.removeEventListener('dataavailable', recorderDataAvailable);
                                delete recorder;
                            }
                            if (mediaStream) {
                                mediaStream.stop();
                                delete mediaStream;
                            }
                        }
                        function loadMediaList() {
                            console.log('Loading media list...');
                            refreshButton.disabled = true;
                            new AWS.DynamoDB.DocumentClient().scan({
                                TableName: config.dynamoDB.table.name
                            }, function (err, data) {
                                if (err) {
                                    console.error('Error loading media list', err);
                                } else {
                                    var items = data.Items.map(function (o) {
                                        o.created = new Date(o.created);
                                        if (o.transcoded) {
                                            o.transcoded = new Date(o.transcoded);
                                        }
                                        return o;
                                    }).sort(function (a, b) {
                                        return a.created < b.created;
                                    });
                                    console.log('Media loaded with ', items.length, 'items');
                                    while (mediaList.firstChild) mediaList.removeChild(mediaList.firstChild);
                                    items.forEach(function (o) {
                                        var id = o.id;
                                        var li = document.createElement('li');
                                        if (o.transcoded) {
                                            var a = document.createElement('a');
                                            a.setAttribute('href', '#');
                                            a.innerText = id;
                                            a.addEventListener('click', function (evt) {
                                                console.log(id, 'clicked');
                                                transcodedPlay(id);
                                                evt.preventDefault();
                                            })
                                            li.appendChild(a);
                                        }
                                        else {
                                            li.innerText = id;
                                        }
                                        mediaList.appendChild(li);
                                    });
                                    mediaList.disabled = false;
                                    console.log('Media list updated');
                                }
                                refreshButton.disabled = false;
                            });
                        }
                        refreshButton.addEventListener('click', function () {
                            loadMediaList();
                        })

                    }
                }
            }
        }
    });
    configRequest.addEventListener('error', function (err) {
        console.erro('Error loading config', JSON.stringify(err));
    });
    console.log('Loading config...');
    configRequest.send();
});