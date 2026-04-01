/**
 * Dotti Interceptor v3.1.1 - Runs in MAIN WORLD
 * Intercepts Flow APIs to capture video/image generation data:
 * 1. uploadUserImage (legacy) -> imageId
 * 2. uploadImage (new) -> media.name (mediaId)
 * 3. batchAsyncGenerateVideoText -> mediaId + prompt text + operationId
 * 4. batchCheckAsyncVideoGenerationStatus -> generation status (SUCCESSFUL/FAILED)
 * 5. batchGenerateImages -> image URLs + prompt
 * 6. upsampleImage -> upscaled image URL
 */
(function() {
  var _DOTTI_DEBUG = false;
  if (window._dottiInterceptorActive) return;
  window._dottiInterceptorActive = true;

  function extractImageId(b64) {
    try {
      while (b64.length % 4 !== 0) b64 += '=';
      var binary = atob(b64);
      var uuids = binary.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi);
      if (uuids && uuids.length >= 2) return uuids[1];
      if (uuids && uuids.length === 1) return uuids[0];
      return null;
    } catch(e) { return null; }
  }

  // Legacy: uploadUserImage
  function processUploadResponse(responseText) {
    try {
      var data = JSON.parse(responseText);
      if (data && data.mediaGenerationId && data.mediaGenerationId.mediaGenerationId) {
        var imageId = extractImageId(data.mediaGenerationId.mediaGenerationId);
        if (imageId) {
          document.dispatchEvent(new CustomEvent('dotti-upload-result', {
            detail: { imageId: imageId, mediaGenerationId: data.mediaGenerationId.mediaGenerationId, source: 'uploadUserImage' }
          }));
        }
      }
    } catch(e) {}
  }

  // New: uploadImage -> response.media.name = UUID
  function processUploadImageResponse(responseText, httpStatus) {
    try {
      var data = JSON.parse(responseText);

      // Detecta erro de upload (400 Bad Request)
      if (data && data.error) {
        var reason = '';
        try {
          var details = data.error.details || [];
          for (var i = 0; i < details.length; i++) {
            if (details[i].reason) {
              reason = details[i].reason;
              break;
            }
          }
        } catch(e) {}

        // PROMINENT_PEOPLE_UPLOAD = imagem com pessoa famosa
        if (reason.indexOf('PROMINENT_PEOPLE') !== -1 ||
            (data.error.message || '').indexOf('prominent') !== -1) {
          document.dispatchEvent(new CustomEvent('dotti-upload-error', {
            detail: { error: 'PROMINENT_PEOPLE', reason: reason, message: data.error.message, source: 'uploadImage' }
          }));
          _DOTTI_DEBUG && console.log('[DottiInterceptor] uploadImage PROMINENT_PEOPLE error');
          return;
        }

        // Outros erros de upload
        document.dispatchEvent(new CustomEvent('dotti-upload-error', {
          detail: { error: 'UPLOAD_FAILED', reason: reason, message: data.error.message || data.error.status, source: 'uploadImage' }
        }));
        _DOTTI_DEBUG && console.log('[DottiInterceptor] uploadImage error:', reason || data.error.message);
        return;
      }

      if (data && data.media && data.media.name) {
        var mediaId = data.media.name;
        var fileName = '';
        try { fileName = data.workflow.metadata.displayName || ''; } catch(e) {}
        document.dispatchEvent(new CustomEvent('dotti-upload-result', {
          detail: { imageId: mediaId, fileName: fileName, source: 'uploadImage' }
        }));
        _DOTTI_DEBUG && console.log('[DottiInterceptor] uploadImage mediaId:', mediaId, 'file:', fileName);
      }
    } catch(e) {
      console.error('[DottiInterceptor] uploadImage parse error:', e);
    }
  }

  function processVideoSubmitResponse(responseText) {
    try {
      var data = JSON.parse(responseText);
      if (!data) return;

      var entries = [];

      // Standard format: data.media array
      var mediaList = data.media || data.medias || [];
      if (!Array.isArray(mediaList)) mediaList = [];

      for (var i = 0; i < mediaList.length; i++) {
        var m = mediaList[i];
        if (!m) continue;

        // MediaId: try multiple paths
        var mediaId = m.name || m.mediaId || m.id || '';
        if (!mediaId && m.media) mediaId = m.media.name || m.media.mediaId || '';

        if (!mediaId) continue; // Skip if no mediaId found

        // Validate: must look like a UUID (avoid false positives)
        if (mediaId.length < 8 || mediaId.indexOf('-') === -1) continue;

        // Check if this is actually a video generation (not just an image upload)
        var hasVideoData = false;
        try { hasVideoData = !!m.video || !!m.mediaMetadata?.requestData?.videoGenerationRequestData; } catch(e) {}
        // Also accept if operations array exists (batch format)
        if (!hasVideoData && data.operations && data.operations.length > 0) hasVideoData = true;
        // Also accept if mediaStatus is PENDING (new generation)
        try { if (m.mediaMetadata?.mediaStatus?.mediaGenerationStatus === 'MEDIA_GENERATION_STATUS_PENDING') hasVideoData = true; } catch(e) {}

        if (!hasVideoData) continue; // Skip non-video media

        // Prompt: try multiple paths
        var prompt = '';
        try { prompt = m.mediaMetadata.requestData.promptInputs[0].structuredPrompt.parts[0].text || ''; } catch(e) {}
        if (!prompt) try { prompt = m.mediaMetadata.requestData.prompt || ''; } catch(e) {}
        if (!prompt) try { prompt = m.video?.generatedVideo?.prompt || ''; } catch(e) {}
        if (!prompt) try { prompt = m.prompt || m.text || ''; } catch(e) {}
        if (!prompt) try { prompt = m.mediaMetadata?.mediaTitle || ''; } catch(e) {}

        // OperationName: try multiple paths
        var opName = '';
        try { opName = m.video.operation.name || ''; } catch(e) {}
        if (!opName) try { opName = m.operation?.name || m.operationName || ''; } catch(e) {}
        if (!opName && data.operations) {
          for (var j = 0; j < data.operations.length; j++) {
            var op = data.operations[j];
            if (op && op.operation && op.operation.name === mediaId) {
              opName = mediaId;
              break;
            }
          }
        }

        entries.push({ mediaId: mediaId, prompt: prompt, operationName: opName });
        _DOTTI_DEBUG && console.log('[DottiInterceptor] VideoSubmit mediaId:', mediaId, 'prompt:', prompt.substring(0, 50));
      }

      // Fallback: single media at root level
      if (entries.length === 0 && data.name) {
        var rootPrompt = '';
        try { rootPrompt = data.mediaMetadata.requestData.promptInputs[0].structuredPrompt.parts[0].text || ''; } catch(e) {}
        if (!rootPrompt) try { rootPrompt = data.mediaMetadata?.mediaTitle || ''; } catch(e) {}

        // Validate it's a video generation
        var isVideo = false;
        try { isVideo = !!data.video || !!data.mediaMetadata?.requestData?.videoGenerationRequestData; } catch(e) {}
        if (!isVideo && data.operations) isVideo = true;
        try { if (data.mediaMetadata?.mediaStatus?.mediaGenerationStatus === 'MEDIA_GENERATION_STATUS_PENDING') isVideo = true; } catch(e) {}

        if (isVideo) {
          entries.push({ mediaId: data.name, prompt: rootPrompt, operationName: '' });
          _DOTTI_DEBUG && console.log('[DottiInterceptor] VideoSubmit (root) mediaId:', data.name);
        }
      }

      if (entries.length > 0) {
        document.dispatchEvent(new CustomEvent('dotti-video-submitted', {
          detail: { media: entries, timestamp: Date.now() }
        }));
        _DOTTI_DEBUG && console.log('[DottiInterceptor] VideoSubmit dispatched:', entries.length, 'entries');
      }
    } catch(e) {
      console.error('[DottiInterceptor] VideoSubmit error:', e);
    }
  }

  function processVideoStatusResponse(responseText) {
    try {
      var data = JSON.parse(responseText);
      if (!data) return;

      var mediaList = data.media || data.medias || [];
      if (!Array.isArray(mediaList)) mediaList = [];

      var updates = [];
      for (var i = 0; i < mediaList.length; i++) {
        var m = mediaList[i];
        if (!m) continue;

        var mediaId = m.name || m.mediaId || m.id || '';
        if (!mediaId && m.media) mediaId = m.media.name || '';
        if (!mediaId) continue;

        var status = '';
        try { status = m.mediaMetadata.mediaStatus.mediaGenerationStatus || ''; } catch(e) {}
        if (!status) try { status = m.status || m.generationStatus || ''; } catch(e) {}

        if (status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL' || status === 'COMPLETED' || status === 'SUCCESSFUL') {
          var prompt = '';
          try { prompt = m.mediaMetadata.requestData.promptInputs[0].structuredPrompt.parts[0].text || ''; } catch(e) {}
          updates.push({ mediaId: mediaId, status: 'COMPLETED', prompt: prompt });
        } else if (status === 'MEDIA_GENERATION_STATUS_FAILED' || status === 'FAILED') {
          var prompt2 = '';
          try { prompt2 = m.mediaMetadata.requestData.promptInputs[0].structuredPrompt.parts[0].text || ''; } catch(e) {}
          updates.push({ mediaId: mediaId, status: 'FAILED', prompt: prompt2 });
        }
      }

      if (updates.length > 0) {
        document.dispatchEvent(new CustomEvent('dotti-video-status', {
          detail: { updates: updates, timestamp: Date.now() }
        }));
      }
    } catch(e) {}
  }

  // Process batchGenerateImages response (text-to-image)
  function processImageGenerateResponse(responseText) {
    try {
      var data = JSON.parse(responseText);
      if (!data || !data.media) return;

      var results = [];
      for (var i = 0; i < data.media.length; i++) {
        var m = data.media[i];
        if (m && m.image && m.image.generatedImage) {
          var gen = m.image.generatedImage;
          var prompt = '';
          if (gen.requestData && gen.requestData.promptInputs && gen.requestData.promptInputs[0]) {
            prompt = gen.requestData.promptInputs[0].textInput || '';
          }
          if (!prompt) prompt = gen.prompt || '';

          results.push({
            mediaId: m.name,
            prompt: prompt,
            imageUrl: gen.fifeUrl || '',
            seed: gen.seed,
            model: gen.modelNameType || '',
            width: m.image.dimensions ? m.image.dimensions.width : 0,
            height: m.image.dimensions ? m.image.dimensions.height : 0
          });
        }
      }

      if (results.length > 0) {
        _DOTTI_DEBUG && console.log('[DottiInterceptor] batchGenerateImages:', results.length, 'imagens');
        document.dispatchEvent(new CustomEvent('dotti-image-generated', {
          detail: { images: results }
        }));
      }
    } catch (e) {
      console.error('[DottiInterceptor] Erro ao processar batchGenerateImages:', e);
    }
  }

  // Process upsampleImage response (upscale)
  function processImageUpscaleResponse(responseText) {
    try {
      var data = JSON.parse(responseText);
      if (data && data.image && data.image.fifeUrl) {
        _DOTTI_DEBUG && console.log('[DottiInterceptor] upsampleImage:', data.image.fifeUrl.substring(0, 80));
        document.dispatchEvent(new CustomEvent('dotti-image-upscaled', {
          detail: {
            imageUrl: data.image.fifeUrl,
            width: data.image.dimensions ? data.image.dimensions.width : 0,
            height: data.image.dimensions ? data.image.dimensions.height : 0
          }
        }));
      }
    } catch (e) {
      console.error('[DottiInterceptor] Erro ao processar upsampleImage:', e);
    }
  }

  function shouldIntercept(url) {
    var isVideoSubmit =
      url.indexOf('batchAsyncGenerateVideoText') !== -1 ||
      url.indexOf('batchAsyncGenerateVideoStartImage') !== -1 ||
      url.indexOf('batchAsyncGenerateVideoReferenceImages') !== -1 ||
      url.indexOf('batchAsyncGenerateVideo') !== -1 ||
      url.indexOf('asyncGenerateVideo') !== -1 ||
      url.indexOf('generateVideo') !== -1 ||
      url.indexOf('createWorkflow') !== -1 ||
      url.indexOf('media.generate') !== -1;

    // Exclui status check e upload do videoSubmit
    if (url.indexOf('batchCheckAsync') !== -1) isVideoSubmit = false;
    if (url.indexOf('uploadImage') !== -1) isVideoSubmit = false;
    if (url.indexOf('getMediaUrl') !== -1) isVideoSubmit = false;

    var isVideoStatus =
      url.indexOf('batchCheckAsyncVideoGenerationStatus') !== -1 ||
      url.indexOf('checkAsyncVideoGeneration') !== -1 ||
      url.indexOf('batchCheckAsync') !== -1;

    return {
      uploadUserImage: url.indexOf('uploadUserImage') !== -1,
      uploadImage: url.indexOf('/uploadImage') !== -1 && url.indexOf('uploadUserImage') === -1,
      videoSubmit: isVideoSubmit,
      videoStatus: isVideoStatus,
      imageGenerate: url.indexOf('batchGenerateImages') !== -1,
      imageUpscale: url.indexOf('upsampleImage') !== -1
    };
  }

  // Intercept XMLHttpRequest
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) { this._dottiUrl = url; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(body) {
    var url = this._dottiUrl || '';
    var checks = shouldIntercept(url);
    if (checks.uploadUserImage) this.addEventListener('load', function() { processUploadResponse(this.responseText); });
    if (checks.uploadImage) this.addEventListener('load', function() {
      _DOTTI_DEBUG && console.log('[DottiInterceptor][XHR] uploadImage response, status:', this.status, 'url:', (this._dottiUrl||'').substring(0, 80));
      processUploadImageResponse(this.responseText);
    });
    if (checks.uploadImage) this.addEventListener('error', function() {
      _DOTTI_DEBUG && console.log('[DottiInterceptor][XHR] uploadImage ERROR event, status:', this.status);
      document.dispatchEvent(new CustomEvent('dotti-upload-error', {
        detail: { error: 'UPLOAD_FAILED', reason: 'XHR error', message: 'Request failed', source: 'uploadImage' }
      }));
    });
    if (checks.videoSubmit) this.addEventListener('load', function() {
      // v3.1.0: HTTP 400 dispatch para recovery
      if (this.status === 400 && url.indexOf('batchAsyncGenerateVideoText') !== -1) {
        document.dispatchEvent(new CustomEvent('dotti-video-submit-error', {
          detail: { httpStatus: this.status, url: url }
        }));
      }
      processVideoSubmitResponse(this.responseText);
    });
    if (checks.videoStatus) this.addEventListener('load', function() { processVideoStatusResponse(this.responseText); });
    if (checks.imageGenerate) this.addEventListener('load', function() {
      if (this.status >= 200 && this.status < 300) processImageGenerateResponse(this.responseText);
      else _DOTTI_DEBUG && console.log('[DottiInterceptor] batchGenerateImages HTTP', this.status);
    });
    if (checks.imageUpscale) this.addEventListener('load', function() { processImageUpscaleResponse(this.responseText); });
    if (_DOTTI_DEBUG && (url.indexOf('video') !== -1 || url.indexOf('Video') !== -1 || url.indexOf('generate') !== -1 || url.indexOf('Generate') !== -1 || url.indexOf('workflow') !== -1)) {
      var self = this;
      this.addEventListener('load', function() {
        console.log('[DottiInterceptor][XHR-DEBUG] URL:', url.substring(0, 120), 'matched:', JSON.stringify(checks));
      });
    }
    return origSend.apply(this, arguments);
  };

  // Intercept fetch
  var origFetch = window.fetch;
  window.fetch = function() {
    var url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url || '');
    var p = origFetch.apply(this, arguments);
    var checks = shouldIntercept(url);
    if (checks.uploadUserImage) p.then(function(r) { r.clone().text().then(processUploadResponse).catch(function(){}); }).catch(function(){});
    if (checks.uploadImage) p.then(function(r) {
      _DOTTI_DEBUG && console.log('[DottiInterceptor][FETCH] uploadImage response, status:', r.status, 'url:', url.substring(0, 80));
      r.clone().text().then(function(text) {
        processUploadImageResponse(text);
      }).catch(function(e) { console.error('[DottiInterceptor][FETCH] uploadImage text error:', e); });
    }).catch(function(e) {
      console.error('[DottiInterceptor][FETCH] uploadImage fetch error:', e);
      document.dispatchEvent(new CustomEvent('dotti-upload-error', {
        detail: { error: 'UPLOAD_FAILED', reason: 'fetch error', message: String(e), source: 'uploadImage' }
      }));
    });
    if (checks.videoSubmit) p.then(function(r) {
      // v3.1.0: HTTP 400 dispatch para recovery
      if (r.status === 400 && url.indexOf('batchAsyncGenerateVideoText') !== -1) {
        document.dispatchEvent(new CustomEvent('dotti-video-submit-error', {
          detail: { httpStatus: r.status, url: url }
        }));
      }
      r.clone().text().then(processVideoSubmitResponse).catch(function(){});
    }).catch(function(){});
    if (checks.videoStatus) p.then(function(r) { r.clone().text().then(processVideoStatusResponse).catch(function(){}); }).catch(function(){});
    if (checks.imageGenerate) p.then(function(r) {
      if (r.ok) r.clone().text().then(processImageGenerateResponse).catch(function(){});
      else _DOTTI_DEBUG && console.log('[DottiInterceptor] batchGenerateImages HTTP', r.status);
    }).catch(function(){});
    if (checks.imageUpscale) p.then(function(r) { r.clone().text().then(processImageUpscaleResponse).catch(function(){}); }).catch(function(){});
    if (_DOTTI_DEBUG && (url.indexOf('video') !== -1 || url.indexOf('Video') !== -1 || url.indexOf('generate') !== -1 || url.indexOf('Generate') !== -1 || url.indexOf('workflow') !== -1)) {
      console.log('[DottiInterceptor][FETCH-DEBUG] URL:', url.substring(0, 120), 'matched:', JSON.stringify(checks));
    }
    return p;
  };

  console.log('[DottiInterceptor] v3.1.1 ativo');
})();
