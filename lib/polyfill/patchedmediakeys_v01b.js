/**
 * @license
 * Copyright 2015 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

goog.provide('shaka.polyfill.PatchedMediaKeys.v01b');

goog.require('shaka.asserts');
goog.require('shaka.log');
goog.require('shaka.util.EventManager');
goog.require('shaka.util.FakeEvent');
goog.require('shaka.util.FakeEventTarget');
goog.require('shaka.util.PublicPromise');
goog.require('shaka.util.Uint8ArrayUtils');


/**
 * Install a polyfill to implement {@link http://goo.gl/blgtZZ EME draft
 * 12 March 2015} on top of {@link http://goo.gl/FSpoAo EME v0.1b}.
 */
shaka.polyfill.PatchedMediaKeys.v01b.install = function() {
  shaka.log.debug('v01b.install');

  shaka.asserts.assert(HTMLMediaElement.prototype.webkitGenerateKeyRequest);

  // Alias.
  var v01b = shaka.polyfill.PatchedMediaKeys.v01b;

  // Construct fake key ID.  This is not done at load-time to avoid exceptions
  // on unsupported browsers.  This particular fake key ID was suggested in
  // w3c/encrypted-media#32.
  v01b.MediaKeyStatusMap.KEY_ID_ = new Uint8Array([0]);

  // Install patches.
  Navigator.prototype.requestMediaKeySystemAccess =
      v01b.requestMediaKeySystemAccess;
  // Delete mediaKeys to work around strict mode compatibility issues.
  delete HTMLMediaElement.prototype['mediaKeys'];
  // Work around read-only declaration for mediaKeys by using a string.
  HTMLMediaElement.prototype['mediaKeys'] = null;
  HTMLMediaElement.prototype.setMediaKeys = v01b.setMediaKeys;
  window.MediaKeys = v01b.MediaKeys;
  window.MediaKeySystemAccess = v01b.MediaKeySystemAccess;
};


/**
 * An implementation of Navigator.prototype.requestMediaKeySystemAccess.
 * Retrieve a MediaKeySystemAccess object.
 *
 * @this {!Navigator}
 * @param {string} keySystem
 * @param {!Array.<!MediaKeySystemConfiguration>} supportedConfigurations
 * @return {!Promise.<!MediaKeySystemAccess>}
 */
shaka.polyfill.PatchedMediaKeys.v01b.requestMediaKeySystemAccess =
    function(keySystem, supportedConfigurations) {
  shaka.log.debug('v01b.requestMediaKeySystemAccess');
  shaka.asserts.assert(this instanceof Navigator);

  // Alias.
  var v01b = shaka.polyfill.PatchedMediaKeys.v01b;
  try {
    var access = new v01b.MediaKeySystemAccess(keySystem,
                                               supportedConfigurations);
    return Promise.resolve(/** @type {!MediaKeySystemAccess} */ (access));
  } catch (exception) {
    return Promise.reject(exception);
  }
};


/**
 * An implementation of HTMLMediaElement.prototype.setMediaKeys.
 * Attach a MediaKeys object to the media element.
 *
 * @this {!HTMLMediaElement}
 * @param {MediaKeys} mediaKeys
 * @return {!Promise}
 */
shaka.polyfill.PatchedMediaKeys.v01b.setMediaKeys = function(mediaKeys) {
  shaka.log.debug('v01b.setMediaKeys');
  shaka.asserts.assert(this instanceof HTMLMediaElement);

  // Alias.
  var v01b = shaka.polyfill.PatchedMediaKeys.v01b;

  var newMediaKeys =
      /** @type {shaka.polyfill.PatchedMediaKeys.v01b.MediaKeys} */ (
          mediaKeys);
  var oldMediaKeys =
      /** @type {shaka.polyfill.PatchedMediaKeys.v01b.MediaKeys} */ (
          this.mediaKeys);

  if (oldMediaKeys && oldMediaKeys != newMediaKeys) {
    shaka.asserts.assert(oldMediaKeys instanceof v01b.MediaKeys);
    // Have the old MediaKeys stop listening to events on the video tag.
    oldMediaKeys.setMedia(null);
  }

  delete this['mediaKeys'];  // in case there is an existing getter
  this['mediaKeys'] = mediaKeys;  // work around read-only declaration

  if (newMediaKeys) {
    shaka.asserts.assert(newMediaKeys instanceof v01b.MediaKeys);
    newMediaKeys.setMedia(this);
  }

  return Promise.resolve();
};


/**
 * For some of this polyfill's implementation, we need to query a video element.
 * But for some embedded systems, it is memory-expensive to create multiple
 * video elements.  Therefore, we check the document to see if we can borrow one
 * to query before we fall back to creating one temporarily.
 *
 * @return {!HTMLVideoElement}
 * @private
 */
shaka.polyfill.PatchedMediaKeys.v01b.getVideoElement_ = function() {
  var videos = document.getElementsByTagName('video');
  /** @type {!HTMLVideoElement} */
  var tmpVideo = videos.length ? videos[0] : document.createElement('video');
  return tmpVideo;
};



/**
 * An implementation of MediaKeySystemAccess.
 *
 * @constructor
 * @param {string} keySystem
 * @param {!Array.<!MediaKeySystemConfiguration>} supportedConfigurations
 * @implements {MediaKeySystemAccess}
 * @throws {Error} if the key system is not supported.
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeySystemAccess =
    function(keySystem, supportedConfigurations) {
  shaka.log.debug('v01b.MediaKeySystemAccess');

  /** @type {string} */
  this.keySystem = keySystem;

  /** @private {string} */
  this.internalKeySystem_ = keySystem;

  /** @private {!MediaKeySystemConfiguration} */
  this.configuration_;

  // This is only a guess, since we don't really know from the prefixed API.
  var allowPersistentState = true;

  if (keySystem == 'org.w3.clearkey') {
    // ClearKey's string must be prefixed in v0.1b.
    this.internalKeySystem_ = 'webkit-org.w3.clearkey';
    // ClearKey doesn't support persistence.
    allowPersistentState = false;
  }

  var success = false;
  var tmpVideo = shaka.polyfill.PatchedMediaKeys.v01b.getVideoElement_();
  for (var i = 0; i < supportedConfigurations.length; ++i) {
    var cfg = supportedConfigurations[i];

    // Create a new config object and start adding in the pieces which we
    // find support for.  We will return this from getConfiguration() if
    // asked.
    /** @type {!MediaKeySystemConfiguration} */
    var newCfg = {
      'audioCapabilities': [],
      'videoCapabilities': [],
      // It is technically against spec to return these as optional, but we
      // don't truly know their values from the prefixed API:
      'persistentState': 'optional',
      'distinctiveIdentifier': 'optional',
      // Pretend the requested init data types are supported, since we don't
      // really know that either:
      'initDataTypes': cfg.initDataTypes,
      'sessionTypes': ['temporary']
    };

    // v0.1b tests for key system availability with an extra argument on
    // canPlayType.
    var ranAnyTests = false;
    if (cfg.audioCapabilities) {
      for (var j = 0; j < cfg.audioCapabilities.length; ++j) {
        var cap = cfg.audioCapabilities[j];
        if (cap.contentType) {
          ranAnyTests = true;
          // In Chrome <= 40, if you ask about Widevine-encrypted audio support,
          // you get a false-negative when you specify codec information.
          // Work around this by stripping codec info for audio types.
          var contentType = cap.contentType.split(';')[0];
          if (tmpVideo.canPlayType(contentType, this.internalKeySystem_)) {
            newCfg.audioCapabilities.push(cap);
            success = true;
          }
        }
      }
    }
    if (cfg.videoCapabilities) {
      for (var j = 0; j < cfg.videoCapabilities.length; ++j) {
        var cap = cfg.videoCapabilities[j];
        if (cap.contentType) {
          ranAnyTests = true;
          if (tmpVideo.canPlayType(cap.contentType, this.internalKeySystem_)) {
            newCfg.videoCapabilities.push(cap);
            success = true;
          }
        }
      }
    }

    if (!ranAnyTests) {
      // If no specific types were requested, we check all common types to find
      // out if the key system is present at all.
      success = tmpVideo.canPlayType('video/mp4', this.internalKeySystem_) ||
                tmpVideo.canPlayType('video/webm', this.internalKeySystem_);
    }
    if (cfg.persistentState == 'required') {
      if (allowPersistentState) {
        newCfg.persistentState = 'required';
        newCfg.sessionTypes = ['persistent-license'];
      } else {
        success = false;
      }
    }

    if (success) {
      this.configuration_ = newCfg;
      return;
    }
  }  // for each cfg in supportedConfigurations

  throw Error('None of the requested configurations were supported.');
};


/** @override */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeySystemAccess.prototype.
    createMediaKeys = function() {
  shaka.log.debug('v01b.MediaKeySystemAccess.createMediaKeys');

  // Alias.
  var v01b = shaka.polyfill.PatchedMediaKeys.v01b;
  var mediaKeys = new v01b.MediaKeys(this.internalKeySystem_);
  return Promise.resolve(/** @type {!MediaKeys} */ (mediaKeys));
};


/** @override */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeySystemAccess.prototype.
    getConfiguration = function() {
  shaka.log.debug('v01b.MediaKeySystemAccess.getConfiguration');
  return this.configuration_;
};



/**
 * An implementation of MediaKeys.
 *
 * @constructor
 * @param {string} keySystem
 * @implements {MediaKeys}
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeys = function(keySystem) {
  shaka.log.debug('v01b.MediaKeys');

  /** @private {string} */
  this.keySystem_ = keySystem;

  /** @private {HTMLMediaElement} */
  this.media_ = null;

  /** @private {!shaka.util.EventManager} */
  this.eventManager_ = new shaka.util.EventManager();

  /**
   * @private {!Array.<!shaka.polyfill.PatchedMediaKeys.v01b.MediaKeySession>}
   */
  this.newSessions_ = [];

  /**
   * @private {!Object.<string,
   *                    !shaka.polyfill.PatchedMediaKeys.v01b.MediaKeySession>}
   */
  this.sessionMap_ = {};
};


/**
 * @param {HTMLMediaElement} media
 * @protected
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeys.prototype.setMedia =
    function(media) {
  this.media_ = media;

  // Remove any old listeners.
  this.eventManager_.removeAll();

  if (media) {
    // Intercept and translate these prefixed EME events.
    this.eventManager_.listen(media, 'webkitneedkey',
        /** @type {shaka.util.EventManager.ListenerType} */ (
            this.onWebkitNeedKey_.bind(this)));

    this.eventManager_.listen(media, 'webkitkeymessage',
        /** @type {shaka.util.EventManager.ListenerType} */ (
            this.onWebkitKeyMessage_.bind(this)));

    this.eventManager_.listen(media, 'webkitkeyadded',
        /** @type {shaka.util.EventManager.ListenerType} */ (
            this.onWebkitKeyAdded_.bind(this)));

    this.eventManager_.listen(media, 'webkitkeyerror',
        /** @type {shaka.util.EventManager.ListenerType} */ (
            this.onWebkitKeyError_.bind(this)));
  }
};


/** @override */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeys.prototype.createSession =
    function(opt_sessionType) {
  shaka.log.debug('v01b.MediaKeys.createSession');

  var sessionType = opt_sessionType || 'temporary';
  // TODO: Consider adding support for persistent-release once Chrome has
  // implemented it natively.  http://crbug.com/448888
  // This is a non-issue if we've deprecated the polyfill by then, since
  // prefixed EME is on its way out.
  if (sessionType != 'temporary' && sessionType != 'persistent-license') {
    throw new TypeError('Session type ' + opt_sessionType +
                        ' is unsupported on this platform.');
  }

  // Alias.
  var v01b = shaka.polyfill.PatchedMediaKeys.v01b;

  // Unprefixed EME allows for session creation without a video tag or src.
  // Prefixed EME requires both a valid HTMLMediaElement and a src.
  var media = this.media_ || /** @type {!HTMLMediaElement} */(
      document.createElement('video'));
  if (!media.src) media.src = 'about:blank';

  var session = new v01b.MediaKeySession(media, this.keySystem_, sessionType);
  this.newSessions_.push(session);
  return session;
};


/** @override */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeys.prototype.setServerCertificate =
    function(serverCertificate) {
  shaka.log.debug('v01b.MediaKeys.setServerCertificate');

  // There is no equivalent in v0.1b, so return failure.
  return Promise.reject(new Error(
      'setServerCertificate not supported on this platform.'));
};


/**
 * @param {!MediaKeyEvent} event
 * @private
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeys.prototype.onWebkitNeedKey_ =
    function(event) {
  shaka.log.debug('v01b.onWebkitNeedKey_', event);
  shaka.asserts.assert(this.media_);

  var event2 = shaka.util.FakeEvent.create({
    type: 'encrypted',
    initDataType: 'webm',  // not used by v0.1b EME, but given a valid value
    initData: event.initData
  });

  this.media_.dispatchEvent(event2);
};


/**
 * @param {!MediaKeyEvent} event
 * @private
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeys.prototype.onWebkitKeyMessage_ =
    function(event) {
  shaka.log.debug('v01b.onWebkitKeyMessage_', event);

  var session = this.findSession_(event.sessionId);
  if (!session) {
    shaka.log.error('Session not found', event.sessionId);
    return;
  }

  var isNew = session.keyStatuses.getStatus() == undefined;

  var event2 = shaka.util.FakeEvent.create({
    type: 'message',
    messageType: isNew ? 'licenserequest' : 'licenserenewal',
    message: event.message
  });

  session.generated();
  session.dispatchEvent(event2);
};


/**
 * @param {!MediaKeyEvent} event
 * @private
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeys.prototype.onWebkitKeyAdded_ =
    function(event) {
  shaka.log.debug('v01b.onWebkitKeyAdded_', event);

  var session = this.findSession_(event.sessionId);
  shaka.asserts.assert(session);
  if (session) {
    session.ready();
  }
};


/**
 * @param {!MediaKeyEvent} event
 * @private
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeys.prototype.onWebkitKeyError_ =
    function(event) {
  shaka.log.debug('v01b.onWebkitKeyError_', event);

  var session = this.findSession_(event.sessionId);
  shaka.asserts.assert(session);
  if (session) {
    session.handleError(event);
  }
};


/**
 * @param {string} sessionId
 * @return {shaka.polyfill.PatchedMediaKeys.v01b.MediaKeySession}
 * @private
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeys.prototype.findSession_ =
    function(sessionId) {
  var session = this.sessionMap_[sessionId];
  if (session) {
    shaka.log.debug('v01b.MediaKeys.findSession_', session);
    return session;
  }

  session = this.newSessions_.shift();
  if (session) {
    session.sessionId = sessionId;
    this.sessionMap_[sessionId] = session;
    shaka.log.debug('v01b.MediaKeys.findSession_', session);
    return session;
  }

  return null;
};



/**
 * An implementation of MediaKeySession.
 *
 * @param {!HTMLMediaElement} media
 * @param {string} keySystem
 * @param {string} sessionType
 *
 * @constructor
 * @implements {MediaKeySession}
 * @extends {shaka.util.FakeEventTarget}
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeySession =
    function(media, keySystem, sessionType) {
  shaka.log.debug('v01b.MediaKeySession');
  shaka.util.FakeEventTarget.call(this, null);

  /** @private {!HTMLMediaElement} */
  this.media_ = media;

  /** @private {boolean} */
  this.initialized_ = false;

  /** @private {shaka.util.PublicPromise} */
  this.generatePromise_ = null;

  /** @private {shaka.util.PublicPromise} */
  this.updatePromise_ = null;

  /** @private {string} */
  this.keySystem_ = keySystem;

  /** @private {string} */
  this.type_ = sessionType;

  /** @type {string} */
  this.sessionId = '';

  /** @type {number} */
  this.expiration = NaN;

  /** @type {!shaka.util.PublicPromise} */
  this.closed = new shaka.util.PublicPromise();

  /** @type {!MediaKeyStatusMap} */
  this.keyStatuses =
      new shaka.polyfill.PatchedMediaKeys.v01b.MediaKeyStatusMap();
};
goog.inherits(shaka.polyfill.PatchedMediaKeys.v01b.MediaKeySession,
              shaka.util.FakeEventTarget);


/**
 * Signals that the license request has been generated.  This resolves the
 * 'generateRequest' promise.
 *
 * @protected
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeySession.prototype.generated =
    function() {
  shaka.log.debug('v01b.MediaKeySession.generated');

  if (this.generatePromise_) {
    this.generatePromise_.resolve();
    this.generatePromise_ = null;
  }
};


/**
 * Signals that the session is 'ready', which is the terminology used in older
 * versions of EME.  The new signal is to resolve the 'update' promise.  This
 * translates between the two.
 *
 * @protected
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeySession.prototype.ready =
    function() {
  shaka.log.debug('v01b.MediaKeySession.ready');

  this.updateKeyStatus_('usable');

  if (this.updatePromise_) {
    this.updatePromise_.resolve();
  }
  this.updatePromise_ = null;
};


/**
 * Either rejects a promise, or dispatches an error event, as appropriate.
 *
 * @param {!MediaKeyEvent} event
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeySession.prototype.handleError =
    function(event) {
  shaka.log.debug('v01b.MediaKeySession.handleError', event);

  // This does not match the DOMException we get in current WD EME, but it will
  // at least provide some information which can be used to look into the
  // problem.
  var error = new Error('EME v0.1b key error');
  error.errorCode = event.errorCode;
  error.errorCode.systemCode = event.systemCode;

  // The presence or absence of sessionId indicates whether this corresponds to
  // generateRequest() or update().
  if (!event.sessionId && this.generatePromise_) {
    error.method = 'generateRequest';
    if (event.systemCode == 45) {
      error.message = 'Unsupported session type.';
    }
    this.generatePromise_.reject(error);
    this.generatePromise_ = null;
  } else if (event.sessionId && this.updatePromise_) {
    error.method = 'update';
    this.updatePromise_.reject(error);
    this.updatePromise_ = null;
  } else {
    // This mapping of key statuses is imperfect at best.
    var code = event.errorCode.code;
    var systemCode = event.systemCode;
    if (code == MediaKeyError['MEDIA_KEYERR_OUTPUT']) {
      this.updateKeyStatus_('output-restricted');
    } else if (systemCode == 1) {
      this.updateKeyStatus_('expired');
    } else {
      this.updateKeyStatus_('internal-error');
    }
  }
};


/**
 * Logic which is shared between generateRequest() and load(), both of which
 * are ultimately implemented with webkitGenerateKeyRequest in prefixed EME.
 *
 * @param {?BufferSource} initData
 * @param {?string} offlineSessionId
 * @return {!Promise}
 * @private
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeySession.prototype.generate_ =
    function(initData, offlineSessionId) {
  if (this.initialized_) {
    return Promise.reject(new Error('The session is already initialized.'));
  }

  this.initialized_ = true;

  /** @type {!Uint8Array} */
  var mangledInitData;

  try {
    if (this.type_ == 'persistent-license') {
      var Uint8ArrayUtils = shaka.util.Uint8ArrayUtils;
      if (!offlineSessionId) {
        // Persisting the initial license.
        // Prefix the init data with a tag to indicate persistence.
        var u8InitData = new Uint8Array(initData);
        mangledInitData = Uint8ArrayUtils.fromString(
            'PERSISTENT|' + Uint8ArrayUtils.toString(u8InitData));
      } else {
        // Loading a stored license.
        // Prefix the init data (which is really a session ID) with a tag to
        // indicate that we are loading a persisted session.
        mangledInitData = Uint8ArrayUtils.fromString(
            'LOAD_SESSION|' + offlineSessionId);
      }
    } else {
      // Streaming.
      shaka.asserts.assert(this.type_ == 'temporary');
      shaka.asserts.assert(!offlineSessionId);
      mangledInitData = new Uint8Array(initData);
    }

    shaka.asserts.assert(mangledInitData);
  } catch (exception) {
    return Promise.reject(exception);
  }

  shaka.asserts.assert(this.generatePromise_ == null);
  this.generatePromise_ = new shaka.util.PublicPromise();

  // Because we are hacking media.src in createSession to better emulate
  // unprefixed EME's ability to create sessions and license requests without a
  // video tag, we can get ourselves into trouble.  It seems that sometimes,
  // the setting of media.src hasn't been processed by some other thread, and
  // GKR can throw an exception.  If this occurs, wait 10 ms and try again at
  // most once.  This situation should only occur when init data is available
  // ahead of the 'needkey' event.
  try {
    this.media_.webkitGenerateKeyRequest(this.keySystem_, mangledInitData);
  } catch (exception) {
    if (exception.name != 'InvalidStateError') {
      this.generatePromise_ = null;
      return Promise.reject(exception);
    }

    setTimeout(function() {
      try {
        this.media_.webkitGenerateKeyRequest(this.keySystem_, mangledInitData);
      } catch (exception) {
        this.generatePromise_.reject(exception);
        this.generatePromise_ = null;
      }
    }.bind(this), 10);
  }

  return this.generatePromise_;
};


/**
 * An internal version of update which defers new calls while old ones are in
 * progress.
 *
 * @param {!shaka.util.PublicPromise} promise  The promise associated with this
 *     call.
 * @param {?BufferSource} response
 * @private
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeySession.prototype.update_ =
    function(promise, response) {
  if (this.updatePromise_) {
    // We already have an update in-progress, so defer this one until after the
    // old one is resolved.  Execute this whether the original one succeeds or
    // fails.
    this.updatePromise_.then(
        this.update_.bind(this, promise, response)
    ).catch(
        this.update_.bind(this, promise, response)
    );
    return;
  }

  this.updatePromise_ = promise;

  var key;
  var keyId;

  if (this.keySystem_ == 'webkit-org.w3.clearkey') {
    // The current EME version of clearkey wants a structured JSON response.
    // The v0.1b version wants just a raw key.  Parse the JSON response and
    // extract the key and key ID.
    var Uint8ArrayUtils = shaka.util.Uint8ArrayUtils;
    var licenseString = Uint8ArrayUtils.toString(new Uint8Array(response));
    var jwkSet = /** @type {JWKSet} */ (JSON.parse(licenseString));
    var kty = jwkSet.keys[0].kty;
    if (kty != 'oct') {
      // Reject the promise.
      var error = new Error('Response is not a valid JSON Web Key Set.');
      this.updatePromise_.reject(error);
      this.updatePromise_ = null;
    }
    key = Uint8ArrayUtils.fromBase64(jwkSet.keys[0].k);
    keyId = Uint8ArrayUtils.fromBase64(jwkSet.keys[0].kid);
  } else {
    // The key ID is not required.
    key = new Uint8Array(response);
    keyId = null;
  }

  try {
    this.media_.webkitAddKey(this.keySystem_, key, keyId, this.sessionId);
  } catch (exception) {
    // Reject the promise.
    this.updatePromise_.reject(exception);
    this.updatePromise_ = null;
  }
};


/**
 * Update key status and dispatch a 'keystatuseschange' event.
 *
 * @param {string} status
 * @private
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeySession.prototype.
    updateKeyStatus_ = function(status) {
  this.keyStatuses.setStatus(status);
  var event = shaka.util.FakeEvent.create({type: 'keystatuseschange'});
  this.dispatchEvent(event);
};


/** @override */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeySession.prototype.generateRequest =
    function(initDataType, initData) {
  shaka.log.debug('v01b.MediaKeySession.generateRequest');
  return this.generate_(initData, null);
};


/** @override */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeySession.prototype.load =
    function(sessionId) {
  shaka.log.debug('v01b.MediaKeySession.load');
  if (this.type_ == 'persistent-license') {
    return this.generate_(null, sessionId);
  } else {
    return Promise.reject(new Error('Not a persistent session.'));
  }
};


/** @override */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeySession.prototype.update =
    function(response) {
  shaka.log.debug('v01b.MediaKeySession.update', response);
  shaka.asserts.assert(this.sessionId);

  var nextUpdatePromise = new shaka.util.PublicPromise();
  this.update_(nextUpdatePromise, response);
  return nextUpdatePromise;
};


/** @override */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeySession.prototype.close =
    function() {
  shaka.log.debug('v01b.MediaKeySession.close');

  // This will remove a persistent session, but it's also the only way to
  // free CDM resources on v0.1b.
  if (this.type_ != 'persistent-license') {
    // sessionId may reasonably be null if no key request has been generated
    // yet.  Unprefixed EME will return a rejected promise in this case.
    // We will use the same error message that Chrome 41 uses in its EME
    // implementation.
    if (!this.sessionId) {
      this.closed.reject(new Error('The session is not callable.'));
      return this.closed;
    }
    this.media_.webkitCancelKeyRequest(this.keySystem_, this.sessionId);
  }

  // Resolve the 'closed' promise and return it.
  this.closed.resolve();
  return this.closed;
};


/** @override */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeySession.prototype.remove =
    function() {
  shaka.log.debug('v01b.MediaKeySession.remove');

  if (this.type_ != 'persistent-license') {
    return Promise.reject(new Error('Not a persistent session.'));
  }

  return this.close();
};



/**
 * An implementation of Iterator.
 *
 * @param {!Array.<VALUE>} values
 *
 * @constructor
 * @implements {Iterator}
 * @template VALUE
 */
shaka.polyfill.PatchedMediaKeys.v01b.Iterator = function(values) {
  /** @private {!Array.<VALUE>} */
  this.values_ = values;

  /** @private {number} */
  this.index_ = 0;
};


/**
 * @return {{value:VALUE, done:boolean}}
 */
shaka.polyfill.PatchedMediaKeys.v01b.Iterator.prototype.next = function() {
  if (this.index_ >= this.values_.length) {
    return {value: undefined, done: true};
  }
  return {value: this.values_[this.index_++], done: false};
};



/**
 * An implementation of MediaKeyStatusMap.
 * This fakes a map with a single key ID.
 *
 * @constructor
 * @implements {MediaKeyStatusMap}
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeyStatusMap = function() {
  /**
   * @type {number}
   */
  this.size = 0;

  /**
   * @private {string|undefined}
   */
  this.status_ = undefined;
};


/**
 * @const {!Uint8Array}
 * @private
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeyStatusMap.KEY_ID_;


/**
 * An internal method used by the session to set key status.
 * @param {string|undefined} status
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeyStatusMap.prototype.setStatus =
    function(status) {
  this.size = status == undefined ? 0 : 1;
  this.status_ = status;
};


/**
 * An internal method used by the session to get key status.
 * @return {string|undefined}
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeyStatusMap.prototype.getStatus =
    function() {
  return this.status_;
};


/**
 * Array entry 0 is the key, 1 is the value.
 * @override
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeyStatusMap.prototype.entries =
    function() {
  var fakeKeyId =
      shaka.polyfill.PatchedMediaKeys.v01b.MediaKeyStatusMap.KEY_ID_;
  /** @type {!Array.<!Array.<BufferSource|string>>} */
  var arr = [];
  if (this.status_) {
    arr.push([fakeKeyId, this.status_]);
  }
  return new shaka.polyfill.PatchedMediaKeys.v01b.Iterator(arr);
};


/**
 * The functor is called with each value.
 * @param {function(string)} fn
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeyStatusMap.prototype.forEach =
    function(fn) {
  if (this.status_) {
    fn(this.status_);
  }
};


/**
 * @param {BufferSource} keyId
 * @return {string|undefined}
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeyStatusMap.prototype.get =
    function(keyId) {
  if (this.has(keyId)) {
    return this.status_;
  }
  return undefined;
};


/**
 * @param {BufferSource} keyId
 * @return {boolean}
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeyStatusMap.prototype.has =
    function(keyId) {
  var fakeKeyId =
      shaka.polyfill.PatchedMediaKeys.v01b.MediaKeyStatusMap.KEY_ID_;
  if (this.status_ &&
      shaka.util.Uint8ArrayUtils.equal(new Uint8Array(keyId), fakeKeyId)) {
    return true;
  }
  return false;
};


/**
 * @override
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeyStatusMap.prototype.keys =
    function() {
  var fakeKeyId =
      shaka.polyfill.PatchedMediaKeys.v01b.MediaKeyStatusMap.KEY_ID_;
  /** @type {!Array.<BufferSource>} */
  var arr = [];
  if (this.status_) {
    arr.push(fakeKeyId);
  }
  return new shaka.polyfill.PatchedMediaKeys.v01b.Iterator(arr);
};


/**
 * @override
 */
shaka.polyfill.PatchedMediaKeys.v01b.MediaKeyStatusMap.prototype.values =
    function() {
  /** @type {!Array.<string>} */
  var arr = [];
  if (this.status_) {
    arr.push(this.status_);
  }
  return new shaka.polyfill.PatchedMediaKeys.v01b.Iterator(arr);
};

