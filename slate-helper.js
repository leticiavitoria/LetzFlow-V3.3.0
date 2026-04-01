/**
 * Dotti Slate Helper v3.1.1 - Runs in MAIN WORLD
 * Handles Slate.js text insertion, submit button click, mode switching, and gallery operations
 * Communicates with content.js (ISOLATED world) via CustomEvents
 *
 * Injected via chrome.runtime.getURL() to bypass CSP
 */
(function() {
  if (window._dottiSlateHelperActive) return;
  window._dottiSlateHelperActive = true;

  // v3.3.0: PointerEvent click helper — required for Radix UI components
  // Simple .click() does NOT work on crop_16_9, mode tabs, etc.
  function _pointerClick(el) {
    var rect = el.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0, detail: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  // ====== SLATE FILL ======
  document.addEventListener('dotti-fill-slate', function(e) {
    var text = (e.detail && e.detail.text) || '';
    var requestId = (e.detail && e.detail.requestId) || '';

    if (!text) {
      _dispatch('dotti-fill-slate-result', { requestId: requestId, result: 'NO_TEXT' });
      return;
    }

    var ta = document.querySelector("[role='textbox']");
    if (!ta) {
      _dispatch('dotti-fill-slate-result', { requestId: requestId, result: 'NO_TEXTBOX' });
      return;
    }

    // Find Slate editor via React Fiber
    var fk = Object.keys(ta).find(function(k) { return k.startsWith('__reactFiber$'); });
    if (!fk) {
      _dispatch('dotti-fill-slate-result', { requestId: requestId, result: 'NO_FIBER' });
      return;
    }

    var fiber = ta[fk], editor = null;
    for (var i = 0; i < 50 && fiber; i++) {
      if (fiber.memoizedProps) {
        if (fiber.memoizedProps.editor && fiber.memoizedProps.editor.insertText) {
          editor = fiber.memoizedProps.editor;
          break;
        }
        if (fiber.memoizedProps.value && fiber.memoizedProps.value.insertText) {
          editor = fiber.memoizedProps.value;
          break;
        }
      }
      fiber = fiber.return;
    }

    if (!editor) {
      _dispatch('dotti-fill-slate-result', { requestId: requestId, result: 'NO_EDITOR' });
      return;
    }

    // Use Slate API to clear and insert text
    try {
      editor.withoutNormalizing(function() {
        try {
          editor.select({ anchor: editor.start([]), focus: editor.end([]) });
          editor.deleteFragment();
        } catch(ex) {
          // Editor may be empty, ignore select/delete errors
        }
        editor.insertText(text);
      });
    } catch(e) {
      _dispatch('dotti-fill-slate-result', { requestId: requestId, result: 'SLATE_ERROR:' + e.message });
      return;
    }

    // Verify insertion
    var inserted = '';
    try { inserted = editor.children[0].children[0].text || ''; } catch(e) {}
    var success = inserted.length > 0;

    _dispatch('dotti-fill-slate-result', {
      requestId: requestId,
      result: success ? 'OK' : 'EMPTY_AFTER_INSERT'
    });
  });

  // ====== SUBMIT CLICK (MAIN WORLD) ======
  document.addEventListener('dotti-click-submit', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';

    // Find submit button (arrow_forward or send icon)
    var btn = null;
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].offsetParent === null) continue;
      var icon = buttons[i].querySelector('i');
      var iconText = icon ? (icon.textContent || '').trim() : '';
      if (iconText === 'arrow_forward' || iconText === 'send') {
        btn = buttons[i];
        break;
      }
    }

    // Fallback: aria-label
    if (!btn) {
      btn = document.querySelector('button[aria-label*="Create"], button[aria-label*="Send"], button[aria-label*="Generate"], button[aria-label*="Criar"], button[aria-label*="Enviar"], button[aria-label*="Gerar"]');
      if (btn && btn.offsetParent === null) btn = null;
    }

    if (!btn) {
      _dispatch('dotti-click-submit-result', { requestId: requestId, result: 'NO_BUTTON' });
      return;
    }

    if (btn.disabled) {
      _dispatch('dotti-click-submit-result', { requestId: requestId, result: 'DISABLED' });
      return;
    }

    // Strategy 1: React onClick directly from MAIN world (most reliable)
    var clicked = false;
    var reactPropsKey = Object.keys(btn).find(function(k) { return k.startsWith('__reactProps$'); });
    if (reactPropsKey && btn[reactPropsKey] && typeof btn[reactPropsKey].onClick === 'function') {
      try {
        btn[reactPropsKey].onClick({
          preventDefault: function(){},
          stopPropagation: function(){},
          nativeEvent: new MouseEvent('click', { bubbles: true }),
          type: 'click',
          target: btn,
          currentTarget: btn
        });
        clicked = true;
      } catch(e) {
        // React click failed, will try fallback
      }
    }

    // Strategy 2: Full 7-event mouse sequence from MAIN world
    if (!clicked) {
      var events = ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
      for (var j = 0; j < events.length; j++) {
        btn.dispatchEvent(new MouseEvent(events[j], {
          bubbles: true, cancelable: true, composed: true, view: window, detail: 1
        }));
      }
      clicked = true;
    }

    _dispatch('dotti-click-submit-result', { requestId: requestId, result: clicked ? 'OK' : 'CLICK_FAILED' });
  });

  // ====== CHECK SLATE STATE ======
  document.addEventListener('dotti-check-slate', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';
    var ta = document.querySelector("[role='textbox']");
    if (!ta) {
      _dispatch('dotti-check-slate-result', { requestId: requestId, isEmpty: true, hasEditor: false });
      return;
    }

    var fk = Object.keys(ta).find(function(k) { return k.startsWith('__reactFiber$'); });
    if (!fk) {
      _dispatch('dotti-check-slate-result', { requestId: requestId, isEmpty: true, hasEditor: false });
      return;
    }

    var fiber = ta[fk], editor = null;
    for (var i = 0; i < 50 && fiber; i++) {
      if (fiber.memoizedProps) {
        if (fiber.memoizedProps.editor && fiber.memoizedProps.editor.insertText) {
          editor = fiber.memoizedProps.editor;
          break;
        }
        if (fiber.memoizedProps.value && fiber.memoizedProps.value.insertText) {
          editor = fiber.memoizedProps.value;
          break;
        }
      }
      fiber = fiber.return;
    }

    if (!editor) {
      _dispatch('dotti-check-slate-result', { requestId: requestId, isEmpty: true, hasEditor: false });
      return;
    }

    var text = '';
    try { text = editor.children[0].children[0].text || ''; } catch(e) {}

    _dispatch('dotti-check-slate-result', {
      requestId: requestId,
      isEmpty: !text.trim(),
      hasEditor: true,
      textLength: text.length
    });
  });

  // ====== GALLERY: OPEN (MAIN WORLD) ======
  // v3.2.0: Clicar no botao add_2/add para abrir galeria de elementos
  document.addEventListener('dotti-open-gallery', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';

    var allBtns = Array.from(document.querySelectorAll('button')).filter(function(b) { return b.offsetParent !== null; });
    var tb = document.querySelector("[role='textbox']");
    var tbRect = tb ? tb.getBoundingClientRect() : null;
    var tbY = tbRect ? tbRect.top : 0;

    // DEBUG: Listar todos os botoes visiveis com icones perto do textbox
    var btnDebug = [];
    for (var d = 0; d < allBtns.length; d++) {
      var dbIcon = allBtns[d].querySelector('i');
      if (!dbIcon) continue;
      var dbText = dbIcon.textContent.trim();
      var dbRect = allBtns[d].getBoundingClientRect();
      var distY = Math.abs(dbRect.top - tbY);
      if (distY < 400) {
        btnDebug.push(dbText + '(y:' + Math.round(distY) + ',x:' + Math.round(dbRect.left) + ')');
      }
    }
    console.log('[DottiSlateHelper] Botoes perto do textbox:', btnDebug.join(', '));

    var addBtn = null;

    // Prioridade 1: icone "add_2" (botao especifico da galeria na v2.0.3)
    for (var i = 0; i < allBtns.length; i++) {
      var icon = allBtns[i].querySelector('i');
      if (icon && icon.textContent.trim() === 'add_2') {
        addBtn = allBtns[i];
        console.log('[DottiSlateHelper] Encontrado add_2');
        break;
      }
    }

    // Prioridade 2: botoes de galeria com icones comuns perto do textbox
    if (!addBtn) {
      var galleryIcons = ['add_2', 'add_photo_alternate', 'add_circle', 'person_add', 'library_add',
                          'collections', 'photo_library', 'image', 'add_a_photo', 'add'];
      for (var gi = 0; gi < galleryIcons.length; gi++) {
        if (addBtn) break;
        for (var j = 0; j < allBtns.length; j++) {
          var ic = allBtns[j].querySelector('i');
          if (!ic) continue;
          var t = ic.textContent.trim();
          if (t !== galleryIcons[gi]) continue;
          if (Math.abs(allBtns[j].getBoundingClientRect().top - tbY) < 200) {
            addBtn = allBtns[j];
            console.log('[DottiSlateHelper] Encontrado', t, 'perto do textbox');
            break;
          }
        }
      }
    }

    // Prioridade 3: Qualquer botao com aria-label contendo "add", "element", "ingredient", "character"
    if (!addBtn) {
      for (var a = 0; a < allBtns.length; a++) {
        var label = (allBtns[a].getAttribute('aria-label') || '').toLowerCase();
        if (label && (label.indexOf('add') >= 0 || label.indexOf('element') >= 0 ||
            label.indexOf('ingredient') >= 0 || label.indexOf('character') >= 0 ||
            label.indexOf('person') >= 0 || label.indexOf('reference') >= 0)) {
          if (Math.abs(allBtns[a].getBoundingClientRect().top - tbY) < 300) {
            addBtn = allBtns[a];
            console.log('[DottiSlateHelper] Encontrado via aria-label:', label);
            break;
          }
        }
      }
    }

    if (!addBtn) {
      _dispatch('dotti-open-gallery-result', { requestId: requestId, result: 'NO_BUTTON', buttons: btnDebug });
      return;
    }

    var iconText = '';
    var btnIcon = addBtn.querySelector('i');
    if (btnIcon) iconText = btnIcon.textContent.trim();
    console.log('[DottiSlateHelper] Clicando botao galeria:', iconText);

    // v3.3.0: Usar _pointerClick para compatibilidade com Radix UI
    _pointerClick(addBtn);
    _dispatch('dotti-open-gallery-result', { requestId: requestId, result: 'OK', method: 'pointerClick', icon: iconText });
  });

  // ====== GALLERY: SORT BY OLDEST (MAIN WORLD) ======
  // v3.3.0: Ordenar galeria por "Mais antigo" / "Oldest" — Radix UI dropdown
  // IMPORTANTE: A galeria tem 2 dropdowns arrow_drop_down:
  //   BTN[0] = filtro de DATA (ex: "Mar 03 - 01:19") — NAO E ESTE
  //   BTN[2] = ORDENACAO (ex: "Recently Used") — ESTE E O CORRETO
  document.addEventListener('dotti-sort-gallery', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';

    var dialog = document.querySelector('[role="dialog"]');
    if (!dialog) {
      _dispatch('dotti-sort-gallery-result', { requestId: requestId, result: 'NO_DIALOG' });
      return;
    }

    // Achar botao de ORDENACAO (nao o de data!)
    // O de ordenacao contem texto como "Recently Used", "Oldest", "Newest", "Mais recente", "Mais antigo"
    var sortBtn = null;
    var sortKeywords = ['recent', 'oldest', 'newest', 'antigo', 'recente', 'novo'];
    var dlgButtons = dialog.querySelectorAll('button');
    for (var i = 0; i < dlgButtons.length; i++) {
      if (dlgButtons[i].textContent.indexOf('arrow_drop_down') < 0) continue;
      var btnTxt = dlgButtons[i].textContent.toLowerCase();
      for (var s = 0; s < sortKeywords.length; s++) {
        if (btnTxt.indexOf(sortKeywords[s]) >= 0) {
          sortBtn = dlgButtons[i];
          break;
        }
      }
      if (sortBtn) break;
    }

    // Fallback: pegar o ULTIMO arrow_drop_down (ordenacao fica depois do filtro de data)
    if (!sortBtn) {
      for (var f = dlgButtons.length - 1; f >= 0; f--) {
        if (dlgButtons[f].textContent.indexOf('arrow_drop_down') >= 0) {
          sortBtn = dlgButtons[f];
          break;
        }
      }
    }

    if (!sortBtn) {
      _dispatch('dotti-sort-gallery-result', { requestId: requestId, result: 'NO_SORT_BTN' });
      return;
    }

    console.log('[DottiSlateHelper] Sort button encontrado:', sortBtn.textContent.trim().substring(0, 50));

    // Se ja esta em "Oldest"/"Mais antigo", pular
    var sortText = sortBtn.textContent.toLowerCase();
    if (sortText.indexOf('antigo') >= 0 || sortText.indexOf('oldest') >= 0) {
      console.log('[DottiSlateHelper] Galeria ja em Mais antigo');
      _dispatch('dotti-sort-gallery-result', { requestId: requestId, result: 'ALREADY_OLDEST' });
      return;
    }

    // Abrir dropdown com _pointerClick
    console.log('[DottiSlateHelper] Abrindo sort dropdown...');
    _pointerClick(sortBtn);

    // Aguardar dropdown abrir e clicar em "Mais antigo"/"Oldest"
    setTimeout(function() {
      var items = document.querySelectorAll('[role="menuitem"], [role="option"], [role="menuitemradio"], [data-radix-collection-item]');
      console.log('[DottiSlateHelper] Sort options encontradas:', items.length);
      var found = false;
      for (var j = 0; j < items.length; j++) {
        var txt = items[j].textContent.trim();
        console.log('[DottiSlateHelper]   option:', txt);
        if (txt.indexOf('antigo') >= 0 || txt.indexOf('ldest') >= 0 || txt === 'Oldest') {
          console.log('[DottiSlateHelper] Selecionando:', txt);
          _pointerClick(items[j]);
          found = true;
          break;
        }
      }

      // Fallback: qualquer elemento visivel com texto "antigo"/"Oldest"
      if (!found) {
        var allEls = document.querySelectorAll('div, span, button, li, a');
        for (var k = 0; k < allEls.length; k++) {
          if (found) break;
          var el = allEls[k];
          var t = el.textContent.trim();
          var r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 10 && r.width < 300 && t.length < 30) {
            if ((t.indexOf('antigo') >= 0 || t === 'Oldest') && el.children.length === 0) {
              console.log('[DottiSlateHelper] Selecionando (fallback):', t);
              _pointerClick(el);
              found = true;
            }
          }
        }
      }

      _dispatch('dotti-sort-gallery-result', { requestId: requestId, result: found ? 'OK' : 'OPTION_NOT_FOUND' });
    }, 1000);
  });

  // ====== GALLERY: SELECT ITEM (MAIN WORLD) ======
  // v3.2.0: Selecionar thumbnail na galeria por indice
  document.addEventListener('dotti-select-gallery-item', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';
    var idx = (e.detail && typeof e.detail.index === 'number') ? e.detail.index : -1;

    // Procurar container da galeria em varias localizacoes
    var container = document.querySelector('[role="dialog"]');
    var source = 'dialog';

    // Fallback: popover Radix
    if (!container || container.querySelectorAll('img').length === 0) {
      var popover = document.querySelector('[data-radix-popper-content-wrapper]') ||
                    document.querySelector('[data-side]');
      if (popover && popover.querySelectorAll('img').length > 0) {
        container = popover;
        source = 'popover';
      }
    }

    // Fallback: data-state="open" com imagens
    if (!container || container.querySelectorAll('img').length === 0) {
      var allOpen = document.querySelectorAll('[data-state="open"]');
      for (var i = 0; i < allOpen.length; i++) {
        if (allOpen[i].querySelectorAll('img').length > 0) {
          container = allOpen[i];
          source = 'data-state-open';
          break;
        }
      }
    }

    // Fallback: qualquer container com grid de imagens
    if (!container || container.querySelectorAll('img').length === 0) {
      container = null;
      source = 'none';
    }

    if (!container) {
      _dispatch('dotti-select-gallery-item-result', { requestId: requestId, result: 'NO_CONTAINER', totalPageImgs: document.querySelectorAll('img').length });
      return;
    }

    // v3.2.5: Galeria virtualizada — usar data-index para encontrar o item correto
    // A galeria so renderiza ~17 imgs por vez (sliding window), mas cada container
    // tem data-index com o indice REAL do item na galeria

    // Encontrar scroll container
    var scrollEl = null;
    var allDivs = container.querySelectorAll('*');
    for (var si = 0; si < allDivs.length; si++) {
      var el = allDivs[si];
      if (el.scrollHeight > el.clientHeight + 10 && el.clientHeight > 30) {
        var ov = getComputedStyle(el).overflowY;
        if ((ov === 'auto' || ov === 'scroll') && el.querySelectorAll('img').length > 0) {
          scrollEl = el;
          break;
        }
      }
    }

    // Tentar encontrar item por data-index (galeria virtualizada)
    var targetItem = container.querySelector('[data-index="' + idx + '"]');
    var imgs = container.querySelectorAll('img');
    console.log('[DottiSlateHelper] Gallery imgs:', imgs.length, 'selecting idx:', idx, 'source:', source, 'dataIndex:', !!targetItem, 'scroll:', !!scrollEl);

    if (targetItem) {
      // Item ja no DOM — scrollar e clicar na img dentro dele
      var targetImg = targetItem.querySelector('img');
      if (targetImg) {
        targetImg.scrollIntoView({ block: 'center', behavior: 'instant' });
        _pointerClick(targetImg);
        _dispatch('dotti-select-gallery-item-result', { requestId: requestId, result: 'OK', imgCount: imgs.length, source: source });
        return;
      }
    }

    // Item com data-index nao encontrado — scroll progressivo para revelar
    if (scrollEl) {
      scrollEl.scrollTop = 0; // comecar do topo
      var scrollAttempts = 0;
      var maxScrollAttempts = 40;

      function findByDataIndex() {
        setTimeout(function() {
          scrollAttempts++;
          var found = container.querySelector('[data-index="' + idx + '"]');

          if (found) {
            var foundImg = found.querySelector('img');
            if (foundImg) {
              foundImg.scrollIntoView({ block: 'center', behavior: 'instant' });
              console.log('[DottiSlateHelper] Gallery data-index=' + idx + ' encontrado apos ' + scrollAttempts + ' scrolls');
              _pointerClick(foundImg);
              _dispatch('dotti-select-gallery-item-result', { requestId: requestId, result: 'OK', imgCount: container.querySelectorAll('img').length, source: source });
              return;
            }
          }

          // Scroll meia pagina para baixo
          var prevTop = scrollEl.scrollTop;
          scrollEl.scrollTop += Math.floor(scrollEl.clientHeight * 0.5);

          // Se nao avancou e nao encontrou — esgotou
          var atEnd = (scrollEl.scrollTop === prevTop) || (scrollEl.scrollTop >= scrollEl.scrollHeight - scrollEl.clientHeight - 5);
          if (scrollAttempts < maxScrollAttempts && !atEnd) {
            findByDataIndex();
          } else if (atEnd && scrollAttempts < maxScrollAttempts) {
            // Chegou ao final sem encontrar — tentar fallback por contagem
            var fallbackImgs = container.querySelectorAll('img');
            console.log('[DottiSlateHelper] Gallery scroll fim, data-index=' + idx + ' nao encontrado. imgs=' + fallbackImgs.length);
            _dispatch('dotti-select-gallery-item-result', { requestId: requestId, result: 'OUT_OF_RANGE', imgCount: fallbackImgs.length, requestedIdx: idx, source: source });
          } else {
            console.log('[DottiSlateHelper] Gallery scroll esgotado apos ' + scrollAttempts + ' tentativas');
            _dispatch('dotti-select-gallery-item-result', { requestId: requestId, result: 'OUT_OF_RANGE', imgCount: container.querySelectorAll('img').length, requestedIdx: idx, source: source });
          }
        }, 350);
      }
      findByDataIndex();
      return;
    }

    // Sem scroll — tentar por indice direto nas imgs
    if (idx >= 0 && idx < imgs.length) {
      _pointerClick(imgs[idx]);
      _dispatch('dotti-select-gallery-item-result', { requestId: requestId, result: 'OK', imgCount: imgs.length, source: source });
    } else {
      _dispatch('dotti-select-gallery-item-result', { requestId: requestId, result: 'OUT_OF_RANGE', imgCount: imgs.length, requestedIdx: idx, source: source });
    }
  });

  // ====== GALLERY: CLOSE DIALOG (MAIN WORLD) ======
  document.addEventListener('dotti-close-gallery', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';

    var dialog = document.querySelector('[role="dialog"]');
    if (!dialog) {
      _dispatch('dotti-close-gallery-result', { requestId: requestId, result: 'NO_DIALOG' });
      return;
    }

    var btns = dialog.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var icon = btns[i].querySelector('i');
      var t = icon ? icon.textContent.trim() : '';
      if (t === 'close' || t === 'done' || t === 'check') {
        _pointerClick(btns[i]);
        _dispatch('dotti-close-gallery-result', { requestId: requestId, result: 'OK', method: t });
        return;
      }
    }

    // Fallback: clicar fora do dialog
    var overlay = dialog.parentElement;
    if (overlay && overlay !== document.body) {
      _pointerClick(overlay);
      _dispatch('dotti-close-gallery-result', { requestId: requestId, result: 'OK', method: 'overlay' });
      return;
    }

    _dispatch('dotti-close-gallery-result', { requestId: requestId, result: 'NO_CLOSE_BTN' });
  });

  // ====== GALLERY: DEBUG INFO (MAIN WORLD) ======
  document.addEventListener('dotti-gallery-debug', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';
    var dialog = document.querySelector('[role="dialog"]');
    var dataOpen = document.querySelector('[data-state="open"]');

    // Listar TODOS os data-state="open" elementos para debug
    var allDataOpen = document.querySelectorAll('[data-state="open"]');
    var dataOpenList = [];
    for (var i = 0; i < allDataOpen.length; i++) {
      var el = allDataOpen[i];
      var r = el.getBoundingClientRect();
      dataOpenList.push({
        tag: el.tagName,
        w: Math.round(r.width),
        h: Math.round(r.height),
        imgs: el.querySelectorAll('img').length,
        html: el.innerHTML.substring(0, 200)
      });
    }

    // Listar todos os overlays/popover que podem ser a galeria
    var popover = document.querySelector('[data-radix-popper-content-wrapper]') ||
                  document.querySelector('[data-side]') ||
                  document.querySelector('[role="listbox"]');

    var info = {
      requestId: requestId,
      hasDialog: !!dialog,
      hasDataOpen: !!dataOpen,
      dataOpenCount: allDataOpen.length,
      dataOpenList: dataOpenList,
      dialogImgCount: dialog ? dialog.querySelectorAll('img').length : 0,
      dataOpenImgCount: dataOpen ? dataOpen.querySelectorAll('img').length : 0,
      dialogBtnCount: dialog ? dialog.querySelectorAll('button').length : 0,
      dialogHTML: dialog ? dialog.innerHTML.substring(0, 1000) : '',
      hasPopover: !!popover,
      popoverTag: popover ? popover.tagName : '',
      popoverImgs: popover ? popover.querySelectorAll('img').length : 0,
      popoverHTML: popover ? popover.innerHTML.substring(0, 500) : '',
      totalImgsOnPage: document.querySelectorAll('img').length
    };
    _dispatch('dotti-gallery-debug-result', info);
  });

  // ====== MODE SWITCH: IMAGE/VIDEO + INGREDIENTS/FRAMES (MAIN WORLD) ======
  // v3.4.0: Suporta DOIS grupos de tabs no seletor de modo:
  //   Group 1 (mediaType): image(icon:image) | video(icon:videocam)
  //   Group 2 (mode):      frames(icon:crop_free) | ingredients(icon:chrome_extension)
  // Ambos sao opcionais — passa so o que precisar
  document.addEventListener('dotti-switch-mode', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';
    var mediaType = (e.detail && e.detail.mediaType) || null; // 'image' or 'video'
    var subMode = (e.detail && e.detail.mode) || null;        // 'ingredients' or 'frames'
    var setX1 = !!(e.detail && e.detail.setX1);
    var forceClick = !!(e.detail && e.detail.forceClick);     // v3.1.0: forcar click mesmo se active

    // Build list of icons to click
    var targets = [];
    if (mediaType === 'image') targets.push('image');
    else if (mediaType === 'video') targets.push('videocam');
    if (subMode === 'ingredients') targets.push('chrome_extension');
    else if (subMode === 'frames') targets.push('crop_free');

    if (targets.length === 0 && !setX1) {
      _dispatch('dotti-switch-mode-result', { requestId: requestId, result: 'NO_TARGETS' });
      return;
    }

    console.log('[DottiSlateHelper] switchMode: mediaType=' + mediaType + ' subMode=' + subMode + ' targets=' + targets.join(','));

    // Find crop_16_9 button (mode selector trigger at bottom of creation area)
    var allBtns = Array.from(document.querySelectorAll('button')).filter(function(b) { return b.offsetParent !== null; });
    var cropBtn = null;
    for (var i = 0; i < allBtns.length; i++) {
      var icon = allBtns[i].querySelector('i');
      if (icon && (icon.textContent.trim() === 'crop_16_9' || icon.textContent.trim() === 'crop_9_16')) {
        cropBtn = allBtns[i];
        break;
      }
    }

    if (!cropBtn) {
      console.log('[DottiSlateHelper] crop_16_9/crop_9_16 not found for mode switch');
      _dispatch('dotti-switch-mode-result', { requestId: requestId, result: 'NO_CROP_BTN' });
      return;
    }

    // Open mode selector
    console.log('[DottiSlateHelper] Opening mode selector...');
    _pointerClick(cropBtn);

    // Wait for tabs to appear
    setTimeout(function() {
      var refreshedBtns = Array.from(document.querySelectorAll('button')).filter(function(b) { return b.offsetParent !== null; });

      // Debug: list visible buttons
      var btnList = [];
      for (var d = 0; d < refreshedBtns.length; d++) {
        var di = refreshedBtns[d].querySelector('i');
        if (di) btnList.push(di.textContent.trim() + '(' + (refreshedBtns[d].getAttribute('data-state') || '') + ')');
      }
      console.log('[DottiSlateHelper] Buttons after open:', btnList.join(', '));

      // Click each target tab sequentially
      var clickResults = [];
      var allAlreadyActive = true;

      for (var t = 0; t < targets.length; t++) {
        var targetIcon = targets[t];
        var targetBtn = null;
        var fallbackBtn = null;
        for (var j = 0; j < refreshedBtns.length; j++) {
          var ic = refreshedBtns[j].querySelector('i');
          if (ic && ic.textContent.trim() === targetIcon) {
            var btnState = refreshedBtns[j].getAttribute('data-state');
            // Preferir botao do mode selector (active/inactive) sobre toolbar (closed/null)
            if (btnState === 'active' || btnState === 'inactive') {
              targetBtn = refreshedBtns[j];
              break;
            }
            if (!fallbackBtn) fallbackBtn = refreshedBtns[j];
          }
        }
        if (!targetBtn) targetBtn = fallbackBtn;

        if (!targetBtn) {
          clickResults.push({ icon: targetIcon, action: 'not_found' });
          allAlreadyActive = false;
          continue;
        }

        var state = targetBtn.getAttribute('data-state');
        if (state === 'active' && !forceClick) {
          clickResults.push({ icon: targetIcon, action: 'already_active' });
        } else {
          console.log('[DottiSlateHelper] Clicking', targetIcon, '(was ' + state + (forceClick ? ', forced' : '') + ')');
          _pointerClick(targetBtn);
          clickResults.push({ icon: targetIcon, action: forceClick && state === 'active' ? 'force_clicked' : 'clicked', was: state });
          allAlreadyActive = false;
        }
      }

      // Set x1 if requested
      setTimeout(function() {
        if (setX1) {
          var btns2 = Array.from(document.querySelectorAll('button')).filter(function(b) { return b.offsetParent !== null; });
          for (var k = 0; k < btns2.length; k++) {
            var txt = btns2[k].textContent.trim();
            if (txt === 'x1' && btns2[k].getAttribute('data-state') === 'inactive') {
              console.log('[DottiSlateHelper] Setting x1');
              _pointerClick(btns2[k]);
              break;
            }
          }
        }

        // Close mode selector
        setTimeout(function() {
          console.log('[DottiSlateHelper] Closing mode selector');
          _pointerClick(cropBtn);

          setTimeout(function() {
            _dispatch('dotti-switch-mode-result', {
              requestId: requestId,
              result: 'OK',
              mediaType: mediaType,
              mode: subMode,
              clicks: clickResults,
              x1Set: setX1
            });
          }, 1000);
        }, 500);
      }, 600);
    }, 1500);
  });

  // ====== FRAME UPLOAD: INITIAL IMAGE (MAIN WORLD) ======
  // v3.6.0: Upload frame image and select it as "Inicial" frame
  // FIXED: Wait for upload completion via dotti-upload-result event from interceptor
  // FIXED: Always sort by "Newest" so first image = just uploaded = correct one
  // Flow: upload via hidden input → WAIT for upload done → click "Inicial" → sort newest → select first
  document.addEventListener('dotti-frame-upload', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';
    var dataUrl = (e.detail && e.detail.dataUrl) || '';
    var imageName = (e.detail && e.detail.imageName) || ('frame_' + Date.now() + '.png');

    if (!dataUrl) {
      _dispatch('dotti-frame-upload-result', { requestId: requestId, result: 'NO_DATA' });
      return;
    }

    console.log('[DottiSlateHelper] Frame upload v3.6.0: ' + imageName);

    // Listen for upload completion from interceptor (both run in MAIN world)
    var uploadDone = false;
    var uploadImageId = null;

    function onUploadResult(ev) {
      var d = ev.detail || {};
      if (d.source === 'uploadImage' || d.source === 'uploadUserImage') {
        uploadDone = true;
        uploadImageId = d.imageId || null;
        console.log('[DottiSlateHelper] Upload confirmed via interceptor. imageId:', uploadImageId);
      }
    }
    function onUploadError(ev) {
      console.log('[DottiSlateHelper] Upload error event:', JSON.stringify(ev.detail));
      uploadDone = true; // proceed anyway
    }
    document.addEventListener('dotti-upload-result', onUploadResult);
    document.addEventListener('dotti-upload-error', onUploadError);

    function cleanupListeners() {
      document.removeEventListener('dotti-upload-result', onUploadResult);
      document.removeEventListener('dotti-upload-error', onUploadError);
    }

    fetch(dataUrl).then(function(resp) {
      return resp.blob();
    }).then(function(blob) {
      var file = new File([blob], imageName, { type: 'image/png' });

      // Step 1: Upload file via hidden input
      var fileInput = document.querySelector('input[type="file"][accept*="image"]') || document.querySelector('input[type="file"]');
      if (!fileInput) {
        console.log('[DottiSlateHelper] No file input found');
        cleanupListeners();
        _dispatch('dotti-frame-upload-result', { requestId: requestId, result: 'NO_FILE_INPUT' });
        return;
      }

      fileInput.value = '';
      var dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('[DottiSlateHelper] File dispatched to input. Waiting for upload to complete...');

      // Step 2: Poll until upload confirmed (max 30s)
      var elapsed = 0;
      var maxUploadWait = 30000;

      function waitForUpload() {
        if (uploadDone) {
          console.log('[DottiSlateHelper] Upload done after ' + elapsed + 'ms. Proceeding to select image.');
          cleanupListeners();
          setTimeout(openInicialAndSelect, 1000);
          return;
        }
        elapsed += 1000;
        if (elapsed >= maxUploadWait) {
          console.log('[DottiSlateHelper] Upload wait timeout (' + maxUploadWait + 'ms), proceeding anyway');
          cleanupListeners();
          openInicialAndSelect();
          return;
        }
        setTimeout(waitForUpload, 1000);
      }

      setTimeout(waitForUpload, 2000); // first check after 2s

      // Step 3: Click "Inicial" slot to open gallery dialog
      function openInicialAndSelect() {
        var startBtn = null;
        var frameKeywords = ['start', 'início', 'inicio', 'inicial'];
        var divBtns = document.querySelectorAll('div[type="button"]');

        for (var s = 0; s < divBtns.length; s++) {
          if (divBtns[s].offsetParent === null) continue;
          var txt = (divBtns[s].textContent || '').trim().toLowerCase();
          for (var k = 0; k < frameKeywords.length; k++) {
            if (txt === frameKeywords[k]) { startBtn = divBtns[s]; break; }
          }
          if (startBtn) break;
        }

        // Fallback: any clickable element with start/inicial text
        if (!startBtn) {
          var allClickable = document.querySelectorAll('button, div[role="button"], [aria-haspopup="dialog"]');
          for (var b = 0; b < allClickable.length; b++) {
            if (allClickable[b].offsetParent === null) continue;
            var bt = (allClickable[b].textContent || '').trim().toLowerCase();
            for (var kk = 0; kk < frameKeywords.length; kk++) {
              if (bt === frameKeywords[kk]) { startBtn = allClickable[b]; break; }
            }
            if (startBtn) break;
          }
        }

        if (!startBtn) {
          console.log('[DottiSlateHelper] Inicial/Start slot not found');
          _dispatch('dotti-frame-upload-result', { requestId: requestId, result: 'NO_START_BTN' });
          return;
        }

        console.log('[DottiSlateHelper] Clicking Inicial slot: "' + startBtn.textContent.trim() + '"');
        _pointerClick(startBtn);

        // Step 4: Wait for dialog to open, then sort by Newest
        setTimeout(function() {
          var dialog = document.querySelector('[role="dialog"][data-state="open"]') || document.querySelector('[role="dialog"]');
          if (!dialog) {
            console.log('[DottiSlateHelper] No dialog opened after clicking Inicial');
            _dispatch('dotti-frame-upload-result', { requestId: requestId, result: 'NO_DIALOG' });
            return;
          }
          console.log('[DottiSlateHelper] Dialog opened. Sorting by newest...');

          // Step 5: Sort by Newest — find the sort dropdown and ensure "Newest" is selected
          sortByNewest(dialog, function() {
            // Step 6: After sort settles, select first image (= newest = just uploaded)
            setTimeout(function() {
              selectFirstImage();
            }, 1500);
          });
        }, 1500);
      }

      // Sort helper: always ensure gallery is sorted by "Newest"
      function sortByNewest(dialog, callback) {
        var dlgBtns = dialog.querySelectorAll('button');
        var sortBtn = null;
        var sortKeywords = ['recent', 'oldest', 'newest', 'antigo', 'recente', 'novo'];

        // Find sort dropdown button (contains arrow_drop_down + a sort keyword)
        for (var sb = 0; sb < dlgBtns.length; sb++) {
          if (dlgBtns[sb].offsetParent === null) continue;
          var btnText = (dlgBtns[sb].textContent || '').toLowerCase();
          if (btnText.indexOf('arrow_drop_down') < 0) continue;
          for (var sk = 0; sk < sortKeywords.length; sk++) {
            if (btnText.indexOf(sortKeywords[sk]) >= 0) {
              sortBtn = dlgBtns[sb];
              break;
            }
          }
          if (sortBtn) break;
        }

        // Fallback: last arrow_drop_down button in dialog (sort is typically after date filter)
        if (!sortBtn) {
          for (var fb = dlgBtns.length - 1; fb >= 0; fb--) {
            if (dlgBtns[fb].offsetParent === null) continue;
            if ((dlgBtns[fb].textContent || '').indexOf('arrow_drop_down') >= 0) {
              sortBtn = dlgBtns[fb];
              break;
            }
          }
        }

        if (!sortBtn) {
          console.log('[DottiSlateHelper] No sort button found in dialog');
          callback();
          return;
        }

        var sortText = (sortBtn.textContent || '').toLowerCase();
        console.log('[DottiSlateHelper] Sort button: "' + sortBtn.textContent.trim().substring(0, 60) + '"');

        // If already "Newest" — skip
        if (sortText.indexOf('newest') >= 0 || sortText.indexOf('mais novo') >= 0 || sortText.indexOf('mais recente') >= 0) {
          console.log('[DottiSlateHelper] Already sorted by Newest');
          callback();
          return;
        }

        // Open dropdown and select "Newest"
        console.log('[DottiSlateHelper] Opening sort dropdown to select Newest...');
        _pointerClick(sortBtn);

        setTimeout(function() {
          var items = document.querySelectorAll('[role="menuitem"], [role="option"], [role="menuitemradio"], [data-radix-collection-item]');
          console.log('[DottiSlateHelper] Sort menu items: ' + items.length);

          var found = false;
          for (var mi = 0; mi < items.length; mi++) {
            var itemTxt = (items[mi].textContent || '').trim();
            console.log('[DottiSlateHelper]   option: "' + itemTxt + '"');
            var itemLow = itemTxt.toLowerCase();
            // Match "Newest" / "Mais novo" / "Mais recente" but NOT "Recently Used"
            if (itemLow === 'newest' || itemLow === 'mais novo' || itemLow === 'mais recente' || itemLow === 'mais recentes') {
              console.log('[DottiSlateHelper] Selecting: ' + itemTxt);
              _pointerClick(items[mi]);
              found = true;
              break;
            }
          }

          // Fallback: any item containing "newest" or "novo"
          if (!found) {
            for (var fi = 0; fi < items.length; fi++) {
              var fTxt = (items[fi].textContent || '').trim().toLowerCase();
              if (fTxt.indexOf('newest') >= 0 || fTxt.indexOf('novo') >= 0 || (fTxt.indexOf('mais') >= 0 && fTxt.indexOf('recente') >= 0)) {
                console.log('[DottiSlateHelper] Selecting (fallback): ' + items[fi].textContent.trim());
                _pointerClick(items[fi]);
                found = true;
                break;
              }
            }
          }

          // Second fallback: scan all visible small text elements
          if (!found) {
            var allEls = document.querySelectorAll('div, span, button, li, a');
            for (var ae = 0; ae < allEls.length; ae++) {
              var el = allEls[ae];
              var t = (el.textContent || '').trim();
              var r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 10 && r.width < 300 && t.length < 30 && el.children.length === 0) {
                var tl = t.toLowerCase();
                if (tl === 'newest' || tl === 'mais novo' || tl === 'mais recente' || tl === 'mais recentes') {
                  console.log('[DottiSlateHelper] Selecting (scan fallback): ' + t);
                  _pointerClick(el);
                  found = true;
                  break;
                }
              }
            }
          }

          if (!found) {
            console.log('[DottiSlateHelper] "Newest" option not found — closing dropdown');
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          }

          // Wait for sort to take effect
          setTimeout(callback, 1000);
        }, 800);
      }

      // Select the correct image in dialog — by uploadImageId if available, fallback to first (newest)
      function selectFirstImage() {
        var retryBudget = 12000;

        function trySelect() {
          if (retryBudget <= 0) {
            console.log('[DottiSlateHelper] Timeout waiting for image in dialog');
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            _dispatch('dotti-frame-upload-result', { requestId: requestId, result: 'TIMEOUT_NO_IMAGE' });
            return;
          }

          var currentDialog = document.querySelector('[role="dialog"]');
          if (!currentDialog) {
            console.log('[DottiSlateHelper] Dialog closed automatically — success');
            _dispatch('dotti-frame-upload-result', { requestId: requestId, result: 'OK', method: 'auto' });
            return;
          }

          // Find asset items in dialog
          var assetItems = currentDialog.querySelectorAll('[class*="sc-5bf79b14"]');
          var assetImgs = currentDialog.querySelectorAll('img[src*="getMediaUrlRedirect"]');

          if (assetItems.length > 0 || assetImgs.length > 0) {
            var clickTarget = null;
            var method = 'first';

            // v3.1.1: Try to find the exact uploaded image by imageId in img src
            if (uploadImageId) {
              for (var ii = 0; ii < assetImgs.length; ii++) {
                var src = assetImgs[ii].getAttribute('src') || '';
                if (src.indexOf(uploadImageId) >= 0) {
                  clickTarget = assetImgs[ii].closest('[class*="sc-5bf79b14"]') || assetImgs[ii].parentElement || assetImgs[ii];
                  method = 'matched_id';
                  console.log('[DottiSlateHelper] Found exact image by ID: ' + uploadImageId);
                  break;
                }
              }
            }

            // Fallback: click the first asset (sorted by newest)
            if (!clickTarget) {
              clickTarget = assetItems.length > 0 ? assetItems[0] :
                  (assetImgs[0].closest('[class*="sc-5bf79b14"]') || assetImgs[0].parentElement || assetImgs[0]);
              console.log('[DottiSlateHelper] Clicking FIRST asset (newest) (' + assetImgs.length + ' imgs total)');
            }

            _pointerClick(clickTarget);

            setTimeout(function() {
              if (!document.querySelector('[role="dialog"]')) {
                _dispatch('dotti-frame-upload-result', { requestId: requestId, result: 'OK', method: method });
                return;
              }
              // Dialog still open — try clicking img directly
              if (uploadImageId) {
                for (var ri = 0; ri < assetImgs.length; ri++) {
                  if ((assetImgs[ri].getAttribute('src') || '').indexOf(uploadImageId) >= 0) {
                    _pointerClick(assetImgs[ri]);
                    break;
                  }
                }
              } else if (assetImgs.length > 0) {
                _pointerClick(assetImgs[0]);
              }
              setTimeout(function() {
                if (!document.querySelector('[role="dialog"]')) {
                  _dispatch('dotti-frame-upload-result', { requestId: requestId, result: 'OK', method: method + '_retry' });
                } else {
                  retryBudget -= 2000;
                  setTimeout(trySelect, 500);
                }
              }, 1000);
            }, 1000);
          } else {
            retryBudget -= 500;
            setTimeout(trySelect, 500);
          }
        }

        trySelect();
      }
    }).catch(function(err) {
      console.log('[DottiSlateHelper] Frame upload error:', err.message);
      cleanupListeners();
      _dispatch('dotti-frame-upload-result', { requestId: requestId, result: 'FETCH_ERROR', error: err.message });
    });
  });

  function _dispatch(eventName, detail) {
    document.dispatchEvent(new CustomEvent(eventName, { detail: detail }));
  }

  // ====== SET VIEW MODE: BATCH/LOTE (MAIN WORLD) ======
  // v3.2.5: Trocar visualizacao para Lote — precisa de MAIN world para React/Radix clicks
  document.addEventListener('dotti-set-view-batch', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';

    // v3.2.5: Verificar se ja esta em modo Lote SEM abrir o painel
    // No modo Lote, os tiles tem um container pai com 2 filhos (video + prompt text)
    // Verificar se algum tile tem texto "PROMPT" no nivel 5
    var tiles = document.querySelectorAll('[data-tile-id]');
    if (tiles.length > 0) {
      var testTile = tiles[0];
      var p = testTile;
      for (var lvl = 0; lvl < 5; lvl++) { p = p ? p.parentElement : null; }
      if (p && p.children.length === 2) {
        var hasPromptText = false;
        for (var ci = 0; ci < p.children.length; ci++) {
          if (!p.children[ci].contains(testTile) && (p.children[ci].textContent || '').length > 30) {
            hasPromptText = true;
          }
        }
        if (hasPromptText) {
          console.log('[DottiSlateHelper] setViewBatch: ja em modo Lote (detectado via DOM)');
          _dispatch('dotti-set-view-batch-result', { requestId: requestId, result: 'ALREADY_BATCH' });
          return;
        }
      }
    }

    // 1. Encontrar botao settings_2
    var allBtns = document.querySelectorAll('button');
    var settingsBtn = null;
    for (var i = 0; i < allBtns.length; i++) {
      var icon = allBtns[i].querySelector('i');
      if (icon && icon.textContent.trim() === 'settings_2' && allBtns[i].offsetParent !== null) {
        settingsBtn = allBtns[i];
        break;
      }
    }
    if (!settingsBtn) {
      console.log('[DottiSlateHelper] setViewBatch: settings_2 nao encontrado');
      _dispatch('dotti-set-view-batch-result', { requestId: requestId, result: 'NO_SETTINGS_BTN' });
      return;
    }

    // 2. Garantir painel fechado antes de abrir (evita toggle)
    var existingTabs = document.querySelectorAll('[role="tab"]');
    var alreadyOpen = false;
    for (var k = 0; k < existingTabs.length; k++) {
      var chkIcon = existingTabs[k].querySelector('i');
      if (chkIcon && chkIcon.textContent.trim() === 'campaign_all') { alreadyOpen = true; break; }
    }
    if (alreadyOpen) {
      // Painel ja aberto — fechar primeiro
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }

    // 3. Abrir painel via pointerClick (onPointerDown do Radix)
    setTimeout(function() {
      _pointerClick(settingsBtn);

      setTimeout(function() {
        // 4. Procurar tab Lote/Batch
        var batchTab = null;
        var tabs = document.querySelectorAll('[role="tab"]');
        for (var j = 0; j < tabs.length; j++) {
          var tabIcon = tabs[j].querySelector('i');
          if (tabIcon && tabIcon.textContent.trim() === 'campaign_all') {
            batchTab = tabs[j];
            break;
          }
        }

        if (!batchTab) {
          console.log('[DottiSlateHelper] setViewBatch: tab batch nao encontrada (' + tabs.length + ' tabs)');
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          _dispatch('dotti-set-view-batch-result', { requestId: requestId, result: 'NO_BATCH_TAB' });
          return;
        }

        if (batchTab.getAttribute('data-state') === 'active') {
          console.log('[DottiSlateHelper] setViewBatch: ja em modo Lote');
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          _dispatch('dotti-set-view-batch-result', { requestId: requestId, result: 'ALREADY_BATCH' });
          return;
        }

        // 5. Clicar na tab Lote via pointerClick
        _pointerClick(batchTab);
        console.log('[DottiSlateHelper] setViewBatch: trocado para Lote');

        setTimeout(function() {
          // 6. Fechar painel
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          _dispatch('dotti-set-view-batch-result', { requestId: requestId, result: 'OK' });
        }, 500);
      }, 1500);
    }, alreadyOpen ? 500 : 0);
  });

  console.log('[DottiSlateHelper] v3.3.0 ativo');
})();
