(function () {
  'use strict';

  var FILL_ORDER = ['grey-20', 'grey-40', 'grey-60', 'grey-80'];
  var FILL_LABEL = {
    'grey-20': 'Grey 20%',
    'grey-40': 'Grey 40%',
    'grey-60': 'Grey 60%',
    'grey-80': 'Grey 80%'
  };
  var FILL_COLOR = {
    'grey-20': '#e8e8e8',
    'grey-40': '#cfcfcf',
    'grey-60': '#a9a9a9',
    'grey-80': '#7f7f7f'
  };
  var KIND_LABEL = { rect: 'Rectangle', ellipse: 'Ellipse', text: 'Text' };

  // Canonical verb dataset. The static markup in index.html mirrors these rows
  // so the initial load state can be inspected without running the script.
  var VERBS = {
    'place.canvas': [
      { key: 'r', id: 'verb.create.rect', label: 'Rectangle', req: 'none', risk: 'low' },
      { key: 'e', id: 'verb.create.ellipse', label: 'Ellipse', req: 'none', risk: 'low' },
      { key: 't', id: 'verb.create.text', label: 'Text', req: 'none', risk: 'low' },
      { key: 'a', id: 'verb.select.all', label: 'Select all', req: 'any', risk: 'low' },
      { key: 'l', id: 'verb.arrange.alignLeft', label: 'Align left', req: 'multi', risk: 'low' }
    ],
    'place.canvas.create': [
      { key: 'r', id: 'verb.create.rect', label: 'Rectangle', req: 'none', risk: 'low' },
      { key: 'e', id: 'verb.create.ellipse', label: 'Ellipse', req: 'none', risk: 'low' },
      { key: 't', id: 'verb.create.text', label: 'Text', req: 'none', risk: 'low' },
      { key: 'd', id: 'verb.create.duplicate', label: 'Duplicate', req: 'single', risk: 'low' }
    ],
    'place.canvas.edit': [
      { key: 'd', id: 'verb.edit.delete', label: 'Delete', req: 'any', risk: 'high' },
      { key: 'n', id: 'verb.edit.rename', label: 'Rename', req: 'single', risk: 'medium' },
      { key: 'a', id: 'verb.edit.deselectAll', label: 'Deselect all', req: 'any', risk: 'low' },
      { key: 'l', id: 'verb.edit.lock', label: 'Lock', req: 'single', risk: 'low' }
    ],
    'place.canvas.arrange': [
      { key: 'l', id: 'verb.arrange.alignLeft', label: 'Align left', req: 'multi', risk: 'low' },
      { key: 'c', id: 'verb.arrange.alignCenter', label: 'Align centre', req: 'multi', risk: 'low' },
      { key: 'd', id: 'verb.arrange.distribute', label: 'Distribute', req: 'multi3', risk: 'low' },
      { key: 'g', id: 'verb.arrange.group', label: 'Group', req: 'multi', risk: 'low' }
    ],
    'place.canvas.style': [
      { key: 'f', id: 'verb.style.setFill', label: 'Set fill', req: 'single', risk: 'low' },
      { key: 'c', id: 'verb.style.copyStyle', label: 'Copy style', req: 'single', risk: 'low' },
      { key: 'v', id: 'verb.style.pasteStyle', label: 'Paste style', req: 'single', risk: 'low' },
      { key: 'r', id: 'verb.style.resetStyle', label: 'Reset style', req: 'single', risk: 'low' }
    ],
    'place.canvas.view': [
      { key: 'i', id: 'verb.view.zoomIn', label: 'Zoom in', req: 'none', risk: 'low' },
      { key: 'o', id: 'verb.view.zoomOut', label: 'Zoom out', req: 'none', risk: 'low' },
      { key: 'f', id: 'verb.view.fit', label: 'Fit to screen', req: 'none', risk: 'low' },
      { key: 'g', id: 'verb.view.toggleGrid', label: 'Toggle grid', req: 'none', risk: 'low' }
    ],
    'place.canvas.file': [
      { key: 's', id: 'verb.file.save', label: 'Save', req: 'none', risk: 'low' },
      { key: 'e', id: 'verb.file.export', label: 'Export', req: 'none', risk: 'low' },
      { key: 'a', id: 'verb.file.saveAs', label: 'Save as', req: 'none', risk: 'medium' },
      { key: 'p', id: 'verb.file.exportPng', label: 'Export PNG', req: 'none', risk: 'low' }
    ]
  };

  function qs(selector, scope) {
    return (scope || document).querySelector(selector);
  }

  function qsa(selector, scope) {
    return Array.prototype.slice.call((scope || document).querySelectorAll(selector));
  }

  var root = qs('[data-testid="proto-root"]');
  var tree = qs('[data-testid="proto-place-tree"]');
  var rail = qs('[data-testid="proto-place-rail"]');
  var railList = qs('[data-testid="proto-contextual-verbs"]');
  var badge = qs('[data-testid="proto-selection-badge"]');
  var railNote = qs('#rail-note');
  var canvas = qs('[data-testid="proto-canvas"]');
  var emptyNote = qs('#empty-note');
  var swatches = qs('#swatches');
  var askEntry = qs('[data-testid="proto-ask-entry"]');
  var mapEntry = qs('[data-testid="proto-map-entry"]');
  var mapOverlay = qs('[data-testid="proto-map-overlay"]');
  var mapClose = qs('[data-testid="proto-map-close"]');
  var launcher = qs('[data-testid="proto-launcher"]');
  var launcherPanel = qs('#launcher-panel');
  var launcherInput = qs('[data-testid="proto-launcher-input"]');
  var launcherReplies = qs('#launcher-replies');
  var sendButton = qs('#launcher-send');
  var browseButton = qs('#launcher-browse');
  var paletteResults = qs('[data-testid="proto-palette-results"]');
  var scopeChip = qs('#scope-chip');
  var undoRegion = qs('#undo-region');
  var undoToast = qs('[data-testid="proto-undo-toast"]');
  var undoCopy = qs('#undo-copy');
  var undoAction = qs('[data-testid="proto-undo-action"]');
  var undoStatus = qs('[data-testid="proto-undo-status"]');
  var objectTemplate = qs('#object-template');

  var PLACES = qsa('[data-testid="proto-place-node"]').map(function (node) {
    return {
      id: node.getAttribute('data-place-id'),
      path: node.getAttribute('data-place-path'),
      parent: node.getAttribute('data-child-of')
    };
  });

  var paletteRows = [];
  PLACES.forEach(function (place) {
    (VERBS[place.id] || []).forEach(function (verb) {
      paletteRows.push({
        placeId: place.id,
        placePath: place.path,
        key: verb.key,
        verbId: verb.id,
        label: verb.label,
        risk: verb.risk,
        req: verb.req
      });
    });
  });

  var state = {
    activePlace: 'place.canvas',
    selection: new Set(),
    objects: [],
    objectSeq: 0,
    counters: {},
    replySeq: 0,
    undo: null,
    undoState: null,
    copiedFill: null,
    mapInvoker: null,
    launcherInvoker: null
  };

  function placeInfo(id) {
    for (var i = 0; i < PLACES.length; i += 1) {
      if (PLACES[i].id === id) return PLACES[i];
    }
    return null;
  }

  function shortName(info) {
    var parts = info.path.split(' > ');
    return parts[parts.length - 1];
  }

  function selectedIds() {
    return Array.prototype.slice.call(state.selection);
  }

  function objectById(id) {
    for (var i = 0; i < state.objects.length; i += 1) {
      if (state.objects[i].getAttribute('data-object-id') === id) return state.objects[i];
    }
    return null;
  }

  function fillLabel(fill) {
    return FILL_LABEL[fill] || fill;
  }

  function fillColor(fill) {
    return FILL_COLOR[fill] || '#cfcfcf';
  }

  function nextFill(fill) {
    var index = FILL_ORDER.indexOf(fill);
    if (index < 0) return FILL_ORDER[1];
    if (index >= FILL_ORDER.length - 1) return FILL_ORDER[FILL_ORDER.length - 1];
    return FILL_ORDER[index + 1];
  }

  function note(text) {
    railNote.textContent = text;
  }

  function renderObjectFill(el) {
    var fill = el.getAttribute('data-fill');
    var readout = el.querySelector('.object-fill');
    if (readout) readout.textContent = 'Fill: ' + fillLabel(fill);
    el.style.background = fillColor(fill);
    el.style.color = fill === 'grey-80' ? '#fafafa' : '#1a1a1a';
  }

  function updateEmptyNote() {
    emptyNote.hidden = state.objects.length > 0;
  }

  function verbEnabled(verbId, req) {
    if (verbId === 'verb.select.all') return state.objects.length > 0;
    if (req === 'none') return true;
    var count = state.selection.size;
    if (req === 'any') return count >= 1;
    if (req === 'single') return count === 1;
    if (req === 'multi') return count >= 2;
    if (req === 'multi3') return count >= 3;
    return true;
  }

  function reasonFor(verbId, req) {
    if (verbId === 'verb.select.all' && state.objects.length === 0) return 'no elements';
    if (req === 'any') return 'needs a selection';
    if (req === 'single') return 'needs exactly one';
    if (req === 'multi') return 'needs two or more';
    if (req === 'multi3') return 'needs three or more';
    return '';
  }

  function updateVerbAvailability() {
    qsa('[data-testid="proto-verb"]', rail).forEach(function (button) {
      var req = button.getAttribute('data-requires-selection');
      var verbId = button.getAttribute('data-verb-id');
      var enabled = verbEnabled(verbId, req);
      button.setAttribute('data-disabled', enabled ? 'false' : 'true');
      button.setAttribute('aria-disabled', enabled ? 'false' : 'true');
      button.title = enabled ? '' : reasonFor(verbId, req);
    });
  }

  function updateSelection() {
    var count = state.selection.size;
    state.objects.forEach(function (el) {
      var id = el.getAttribute('data-object-id');
      var selected = state.selection.has(id);
      el.setAttribute('data-selected', selected ? 'true' : 'false');
      var tag = el.querySelector('.sel-tag');
      if (tag) tag.hidden = !selected;
    });
    root.setAttribute('data-selection-count', String(count));
    badge.setAttribute('data-selection-count', String(count));
    badge.textContent = count + ' selected';
    updateVerbAvailability();
    if (launcherOpen() && launcherMode() === 'palette') {
      renderPalette(launcherInput.value);
    }
  }

  function selectOnly(id) {
    state.selection = new Set([id]);
    updateSelection();
  }

  function toggleSelection(id) {
    if (state.selection.has(id)) {
      state.selection.delete(id);
    } else {
      state.selection.add(id);
    }
    updateSelection();
  }

  function clearSelection() {
    state.selection = new Set();
    updateSelection();
  }

  function selectAll() {
    state.selection = new Set(state.objects.map(function (el) {
      return el.getAttribute('data-object-id');
    }));
    updateSelection();
  }

  function createObject(kind) {
    state.counters[kind] = (state.counters[kind] || 0) + 1;
    state.objectSeq += 1;
    var id = 'object-' + state.objectSeq;
    var label = KIND_LABEL[kind] + ' ' + state.counters[kind];
    var el = objectTemplate.content.firstElementChild.cloneNode(true);
    el.setAttribute('data-object-id', id);
    el.setAttribute('data-kind', kind);
    el.setAttribute('data-fill', 'grey-40');
    el.setAttribute('data-selected', 'false');
    el.setAttribute('data-label', label);
    el.querySelector('.object-label').textContent = label;
    var index = state.objects.length;
    el.style.left = (40 + (index % 3) * 190) + 'px';
    el.style.top = (40 + Math.floor(index / 3) * 130) + 'px';
    renderObjectFill(el);
    canvas.appendChild(el);
    state.objects.push(el);
    wireObject(el);
    selectOnly(id);
    updateEmptyNote();
    note(label + ' added.');
  }

  function wireObject(el) {
    el.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return;
      event.stopPropagation();
      var id = el.getAttribute('data-object-id');
      if (event.shiftKey) {
        toggleSelection(id);
        return;
      }
      if (!state.selection.has(id)) selectOnly(id);
      startDrag(el, event);
    });
  }

  function startDrag(el, event) {
    var startX = event.clientX;
    var startY = event.clientY;
    var startLeft = parseFloat(el.style.left) || 0;
    var startTop = parseFloat(el.style.top) || 0;

    function move(moveEvent) {
      el.style.left = (startLeft + moveEvent.clientX - startX) + 'px';
      el.style.top = (startTop + moveEvent.clientY - startY) + 'px';
    }

    function stop() {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', stop);
    }

    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', stop);
  }

  function deleteSelected() {
    var ids = selectedIds();
    ids.forEach(function (id) {
      var el = objectById(id);
      if (!el) return;
      el.remove();
      state.objects = state.objects.filter(function (item) { return item !== el; });
    });
    state.selection = new Set();
    updateSelection();
    updateEmptyNote();
    note('Deleted ' + ids.length + ' element(s).');
  }

  function duplicateSelected() {
    var ids = selectedIds();
    if (ids.length !== 1) {
      note('needs exactly one');
      return;
    }
    var source = objectById(ids[0]);
    if (!source) return;
    state.objectSeq += 1;
    var id = 'object-' + state.objectSeq;
    var copy = source.cloneNode(true);
    copy.setAttribute('data-object-id', id);
    copy.setAttribute('data-selected', 'false');
    copy.setAttribute('data-locked', 'false');
    var tag = copy.querySelector('.sel-tag');
    if (tag) tag.hidden = true;
    var lock = copy.querySelector('.lock-tag');
    if (lock) lock.hidden = true;
    var label = (source.getAttribute('data-label') || 'Object') + ' copy';
    copy.setAttribute('data-label', label);
    copy.querySelector('.object-label').textContent = label;
    copy.style.left = ((parseFloat(source.style.left) || 0) + 24) + 'px';
    copy.style.top = ((parseFloat(source.style.top) || 0) + 24) + 'px';
    renderObjectFill(copy);
    canvas.appendChild(copy);
    state.objects.push(copy);
    wireObject(copy);
    selectOnly(id);
    updateEmptyNote();
  }

  function renameSelected() {
    var ids = selectedIds();
    if (ids.length !== 1) {
      note('needs exactly one');
      return;
    }
    var el = objectById(ids[0]);
    if (!el) return;
    var label = (el.getAttribute('data-label') || 'Object') + ' (renamed)';
    el.setAttribute('data-label', label);
    el.querySelector('.object-label').textContent = label;
    note('Renamed to ' + label + '.');
  }

  function toggleLockSelected() {
    var ids = selectedIds();
    if (ids.length !== 1) {
      note('needs exactly one');
      return;
    }
    var el = objectById(ids[0]);
    if (!el) return;
    var locked = el.getAttribute('data-locked') === 'true';
    el.setAttribute('data-locked', locked ? 'false' : 'true');
    var lock = el.querySelector('.lock-tag');
    if (lock) lock.hidden = locked;
    note(locked ? 'Unlocked.' : 'Locked.');
  }

  function alignLeft(ids) {
    if (!ids || ids.length < 2) {
      note('needs two or more');
      return;
    }
    var elements = ids.map(objectById).filter(Boolean);
    var min = Math.min.apply(null, elements.map(function (el) {
      return parseFloat(el.style.left) || 0;
    }));
    elements.forEach(function (el) {
      el.style.left = min + 'px';
    });
    note('Aligned ' + elements.length + ' elements to the left edge.');
  }

  function alignCenter(ids) {
    if (!ids || ids.length < 2) {
      note('needs two or more');
      return;
    }
    var elements = ids.map(objectById).filter(Boolean);
    var total = elements.reduce(function (sum, el) {
      return sum + (parseFloat(el.style.left) || 0) + el.offsetWidth / 2;
    }, 0);
    var center = total / elements.length;
    elements.forEach(function (el) {
      el.style.left = (center - el.offsetWidth / 2) + 'px';
    });
    note('Aligned ' + elements.length + ' elements to the centre.');
  }

  function distribute(ids) {
    if (!ids || ids.length < 3) {
      note('needs three or more');
      return;
    }
    var elements = ids.map(objectById).filter(Boolean).sort(function (a, b) {
      return (parseFloat(a.style.left) || 0) - (parseFloat(b.style.left) || 0);
    });
    var first = parseFloat(elements[0].style.left) || 0;
    var last = parseFloat(elements[elements.length - 1].style.left) || 0;
    var gap = (last - first) / (elements.length - 1);
    elements.forEach(function (el, index) {
      el.style.left = (first + gap * index) + 'px';
    });
    note('Distributed ' + elements.length + ' elements.');
  }

  function cycleFill() {
    var ids = selectedIds();
    if (ids.length !== 1) {
      note('needs exactly one');
      return;
    }
    var el = objectById(ids[0]);
    if (!el) return;
    el.setAttribute('data-fill', nextFill(el.getAttribute('data-fill')));
    renderObjectFill(el);
    note('Fill set to ' + fillLabel(el.getAttribute('data-fill')) + '.');
  }

  function copyStyle() {
    var ids = selectedIds();
    if (ids.length !== 1) {
      note('needs exactly one');
      return;
    }
    state.copiedFill = objectById(ids[0]).getAttribute('data-fill');
    note('Style copied.');
  }

  function pasteStyle() {
    var ids = selectedIds();
    if (ids.length !== 1) {
      note('needs exactly one');
      return;
    }
    if (!state.copiedFill) {
      note('No copied style.');
      return;
    }
    var el = objectById(ids[0]);
    el.setAttribute('data-fill', state.copiedFill);
    renderObjectFill(el);
    note('Style pasted.');
  }

  function resetStyle() {
    var ids = selectedIds();
    if (ids.length !== 1) {
      note('needs exactly one');
      return;
    }
    var el = objectById(ids[0]);
    el.setAttribute('data-fill', 'grey-40');
    renderObjectFill(el);
    note('Style reset.');
  }

  function executeVerb(verbId) {
    switch (verbId) {
      case 'verb.create.rect':
        createObject('rect');
        break;
      case 'verb.create.ellipse':
        createObject('ellipse');
        break;
      case 'verb.create.text':
        createObject('text');
        break;
      case 'verb.select.all':
        selectAll();
        break;
      case 'verb.edit.deselectAll':
        clearSelection();
        break;
      case 'verb.edit.delete':
        deleteSelected();
        break;
      case 'verb.edit.rename':
        renameSelected();
        break;
      case 'verb.edit.lock':
        toggleLockSelected();
        break;
      case 'verb.create.duplicate':
        duplicateSelected();
        break;
      case 'verb.arrange.alignLeft':
        alignLeft(selectedIds());
        break;
      case 'verb.arrange.alignCenter':
        alignCenter(selectedIds());
        break;
      case 'verb.arrange.distribute':
        distribute(selectedIds());
        break;
      case 'verb.arrange.group':
        note('Grouped ' + state.selection.size + ' elements.');
        break;
      case 'verb.style.setFill':
        cycleFill();
        break;
      case 'verb.style.copyStyle':
        copyStyle();
        break;
      case 'verb.style.pasteStyle':
        pasteStyle();
        break;
      case 'verb.style.resetStyle':
        resetStyle();
        break;
      case 'verb.view.zoomIn':
        note('Zoom in simulated.');
        break;
      case 'verb.view.zoomOut':
        note('Zoom out simulated.');
        break;
      case 'verb.view.fit':
        note('Fit to screen simulated.');
        break;
      case 'verb.view.toggleGrid':
        note('Grid toggled.');
        break;
      case 'verb.file.save':
        note('Save simulated — no file is written');
        break;
      case 'verb.file.export':
        note('Export simulated — no file is written');
        break;
      case 'verb.file.saveAs':
        note('Save as simulated — no file is written');
        break;
      case 'verb.file.exportPng':
        note('Export PNG simulated — no file is written');
        break;
      default:
        break;
    }
  }

  function handleAlias(verbId) {
    if (verbId === 'verb.place.arrange') {
      navigateTo('place.canvas.arrange');
      return;
    }
    if (verbId === 'verb.place.style') {
      navigateTo('place.canvas.style');
      return;
    }
    if (verbId === 'verb.place.file') {
      navigateTo('place.canvas.file');
      return;
    }
    executeVerb(verbId);
  }

  function aliasOwner(verbId) {
    if (verbId.indexOf('verb.create.') === 0) return 'place.canvas';
    if (verbId === 'verb.place.arrange') return 'place.canvas.arrange';
    if (verbId === 'verb.place.style') return 'place.canvas.style';
    if (verbId === 'verb.place.file') return 'place.canvas.file';
    return 'place.canvas';
  }

  function renderRailVerbs(placeId) {
    var verbs = VERBS[placeId] || [];
    railList.innerHTML = '';
    verbs.forEach(function (verb) {
      var item = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'verb';
      button.setAttribute('data-testid', 'proto-verb');
      button.setAttribute('data-place-id', placeId);
      button.setAttribute('data-verb-id', verb.id);
      button.setAttribute('data-key', verb.key);
      button.setAttribute('data-label', verb.label);
      button.setAttribute('data-requires-selection', verb.req);
      button.setAttribute('data-risk', verb.risk);
      button.setAttribute('data-disabled', 'false');
      var key = document.createElement('kbd');
      key.textContent = verb.key;
      var label = document.createElement('span');
      label.className = 'verb-label';
      label.textContent = verb.label;
      button.appendChild(key);
      button.appendChild(label);
      button.addEventListener('click', function () {
        if (button.getAttribute('data-disabled') === 'true') return;
        executeVerb(verb.id);
      });
      item.appendChild(button);
      railList.appendChild(item);
    });
    railList.setAttribute('data-verb-count', String(verbs.length));
    updateVerbAvailability();
  }

  function appendCrumb(breadcrumb, info, current) {
    var crumb = document.createElement('button');
    crumb.type = 'button';
    crumb.className = 'crumb';
    crumb.setAttribute('data-testid', 'proto-breadcrumb-crumb');
    crumb.setAttribute('data-place-id', info.id);
    crumb.textContent = shortName(info);
    if (current) crumb.setAttribute('aria-current', 'page');
    crumb.addEventListener('click', function () {
      navigateTo(info.id);
    });
    breadcrumb.appendChild(crumb);
  }

  function renderBreadcrumb(placeId) {
    var info = placeInfo(placeId);
    var breadcrumb = qs('[data-testid="proto-breadcrumb"]');
    breadcrumb.innerHTML = '';
    if (info.parent) {
      appendCrumb(breadcrumb, placeInfo(info.parent), false);
      appendCrumb(breadcrumb, info, true);
      breadcrumb.setAttribute('data-crumb-count', '2');
    } else {
      appendCrumb(breadcrumb, info, true);
      breadcrumb.setAttribute('data-crumb-count', '1');
    }
  }

  function updateTreeActive(placeId) {
    qsa('[data-testid="proto-place-node"]').forEach(function (node) {
      var active = node.getAttribute('data-place-id') === placeId;
      if (active) {
        node.setAttribute('aria-current', 'page');
      } else {
        node.removeAttribute('aria-current');
      }
      var here = node.querySelector('.here');
      if (here) here.hidden = !active;
    });
  }

  function updateScope() {
    var info = placeInfo(state.activePlace);
    scopeChip.textContent = 'Scope: ' + (info ? info.path : 'Canvas');
  }

  function flashVerb(verbId) {
    var button = rail.querySelector('[data-testid="proto-verb"][data-verb-id="' + verbId + '"]');
    if (!button) return;
    button.classList.add('flash');
    window.setTimeout(function () {
      button.classList.remove('flash');
    }, 500);
  }

  function navigateTo(placeId, flashVerbId) {
    var info = placeInfo(placeId);
    if (!info) return;
    state.activePlace = placeId;
    root.setAttribute('data-active-place', placeId);
    rail.setAttribute('data-place-id', placeId);
    updateTreeActive(placeId);
    renderBreadcrumb(placeId);
    renderRailVerbs(placeId);
    swatches.hidden = placeId !== 'place.canvas.style';
    updateScope();
    railNote.textContent = '';
    if (flashVerbId) flashVerb(flashVerbId);
  }

  function mapOpen() {
    return mapOverlay.getAttribute('data-open') === 'true';
  }

  function updateMapCurrent() {
    qsa('[data-testid="proto-map-group"]', mapOverlay).forEach(function (group) {
      var marker = group.querySelector('.current-marker');
      if (marker) marker.hidden = group.getAttribute('data-place-id') !== state.activePlace;
    });
  }

  function openMap() {
    closeLauncher(false);
    state.mapInvoker = document.activeElement;
    mapOverlay.setAttribute('data-open', 'true');
    mapOverlay.setAttribute('aria-hidden', 'false');
    updateMapCurrent();
    mapClose.focus();
  }

  function closeMap(noFocus) {
    mapOverlay.setAttribute('data-open', 'false');
    mapOverlay.setAttribute('aria-hidden', 'true');
    if (noFocus === true) return;
    var invoker = state.mapInvoker;
    if (invoker && typeof invoker.focus === 'function') {
      invoker.focus();
    } else {
      mapEntry.focus();
    }
  }

  function launcherOpen() {
    return launcher.getAttribute('data-open') === 'true';
  }

  function launcherMode() {
    return launcher.getAttribute('data-launcher-mode');
  }

  function setLauncherMode(mode) {
    launcher.setAttribute('data-launcher-mode', mode);
    launcherInput.placeholder = mode === 'palette' ? '> filter actions' : '';
  }

  function openLauncher(mode) {
    closeMap(true);
    state.launcherInvoker = document.activeElement;
    launcher.setAttribute('data-open', 'true');
    launcher.setAttribute('aria-hidden', 'false');
    setLauncherMode(mode === 'palette' ? 'palette' : 'natural');
    updateScope();
    if (launcherMode() === 'palette') renderPalette(launcherInput.value);
    launcherInput.focus();
  }

  function closeLauncher(restoreFocus) {
    launcher.setAttribute('data-open', 'false');
    launcher.setAttribute('aria-hidden', 'true');
    if (restoreFocus === false) return;
    if (askEntry) askEntry.focus();
  }

  function launcherEscape() {
    if (launcherMode() === 'palette') {
      setLauncherMode('natural');
      launcherInput.focus();
      return;
    }
    closeLauncher(true);
  }

  function appendReply(text) {
    state.replySeq += 1;
    var item = document.createElement('li');
    item.className = 'reply';
    item.setAttribute('data-testid', 'proto-launcher-reply');
    item.setAttribute('data-reply-id', 'reply-' + state.replySeq);
    item.textContent = text;
    launcherReplies.appendChild(item);
  }

  function recordUndo(change) {
    state.undo = change;
    state.undoState = 'available';
    undoToast.setAttribute('data-change-target', change.target);
    undoToast.setAttribute('data-change-property', change.property);
    undoToast.setAttribute('data-attribution', 'companion');
    undoCopy.textContent = 'The companion changed “' + change.target + '” · ' + change.property;
    undoAction.setAttribute('aria-disabled', 'false');
    undoAction.textContent = 'Undo';
    undoStatus.setAttribute('data-undo-state', 'available');
    undoStatus.textContent = 'Undo available';
    undoRegion.hidden = false;
  }

  function applyUndo() {
    if (state.undoState === 'applied') return;
    if (!state.undo) {
      undoStatus.textContent = 'Nothing to undo';
      return;
    }
    var change = state.undo;
    if (change.property === 'fill') {
      var el = objectById(change.objectId);
      if (el) {
        el.setAttribute('data-fill', change.before);
        renderObjectFill(el);
      }
      undoStatus.textContent = 'Undone — fill restored to ' + fillLabel(change.before);
    } else if (change.property === 'position') {
      change.before.forEach(function (entry) {
        var target = objectById(entry.id);
        if (!target) return;
        target.style.left = entry.left;
        target.style.top = entry.top;
      });
      undoStatus.textContent = 'Undone — position restored';
    }
    state.undoState = 'applied';
    undoStatus.setAttribute('data-undo-state', 'applied');
    undoCopy.textContent = 'The companion changed “' + change.target + '” · ' + change.property + ' — undone';
    undoAction.setAttribute('aria-disabled', 'true');
  }

  function companionFill() {
    var ids = selectedIds();
    var el = objectById(ids[0]);
    var before = el.getAttribute('data-fill');
    var next = nextFill(before);
    el.setAttribute('data-fill', next);
    renderObjectFill(el);
    var label = el.getAttribute('data-label') || 'element';
    appendReply('Changed “' + label + '” — fill: ' + fillLabel(before) + ' → ' + fillLabel(next) + '.');
    recordUndo({ target: label, property: 'fill', objectId: ids[0], before: before });
  }

  function companionAlign() {
    var ids = selectedIds();
    var before = ids.map(function (id) {
      var el = objectById(id);
      return { id: id, left: el.style.left, top: el.style.top };
    });
    alignLeft(ids);
    appendReply('Aligned ' + ids.length + ' elements to the left edge.');
    recordUndo({ target: ids.length + ' elements', property: 'position', before: before });
  }

  function submitNatural() {
    if (launcherMode() === 'palette') return;
    var query = launcherInput.value.trim();
    if (!query) return;
    var fillIntent = /fill|colour|color|shade|darker|lighter|grey/i.test(query);
    var alignIntent = /align|line up|arrange|even/i.test(query);
    var count = state.selection.size;
    if (fillIntent && count === 1) {
      companionFill();
    } else if (alignIntent && count >= 2) {
      companionAlign();
    } else if ((fillIntent || alignIntent) && count === 0) {
      appendReply('Which element? Select one, or name it.');
    } else {
      appendReply('I can’t apply that in this prototype — select an element and name a property, such as its fill.');
    }
    launcherInput.value = '';
  }

  function handleLauncherInput() {
    if (launcherMode() !== 'palette' && launcherInput.value.charAt(0) === '>') {
      launcherInput.value = launcherInput.value.slice(1);
      setLauncherMode('palette');
      renderPalette(launcherInput.value);
      return;
    }
    if (launcherMode() === 'palette') {
      renderPalette(launcherInput.value);
    }
  }

  function cell(testid, text) {
    var span = document.createElement('span');
    span.setAttribute('data-testid', testid);
    span.textContent = text;
    return span;
  }

  function buildPaletteRow(row) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'palette-row';
    button.setAttribute('data-testid', 'proto-palette-result');
    button.setAttribute('data-verb-id', row.verbId);
    button.setAttribute('data-risk', row.risk);
    button.appendChild(cell('proto-palette-result-place-path', row.placePath));
    button.appendChild(cell('proto-palette-result-key', row.key || '—'));
    button.appendChild(cell('proto-palette-result-risk', row.risk));
    var label = document.createElement('span');
    label.className = 'palette-label';
    label.textContent = row.label;
    button.appendChild(label);

    var enabled = verbEnabled(row.verbId, row.req);
    if (!enabled) {
      button.setAttribute('aria-disabled', 'true');
      var reason = document.createElement('span');
      reason.className = 'palette-note';
      reason.textContent = 'needs a selection';
      button.appendChild(reason);
    }

    button.addEventListener('click', function () {
      if (button.getAttribute('aria-disabled') === 'true') return;
      if (row.risk === 'high' && button.getAttribute('data-confirm') !== 'true') {
        button.setAttribute('data-confirm', 'true');
        label.textContent = 'Confirm — ' + row.label;
        return;
      }
      executeVerb(row.verbId);
      closeLauncher(true);
    });

    return button;
  }

  function renderPalette(query) {
    paletteResults.innerHTML = '';
    var text = (query || '').trim().toLowerCase();
    var matches = paletteRows.filter(function (row) {
      if (!text) return true;
      var haystack = (row.label + ' ' + row.verbId + ' ' + row.placePath + ' ' + row.key).toLowerCase();
      return haystack.indexOf(text) !== -1;
    });

    if (matches.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'no-match';
      empty.textContent = 'No actions match “' + (query || '') + '”';
      paletteResults.appendChild(empty);
      return;
    }

    var lastPath = null;
    matches.forEach(function (row) {
      if (row.placePath !== lastPath) {
        var heading = document.createElement('p');
        heading.className = 'palette-group-title';
        heading.textContent = row.placePath;
        paletteResults.appendChild(heading);
        lastPath = row.placePath;
      }
      paletteResults.appendChild(buildPaletteRow(row));
    });
  }

  function trapFocus(container) {
    container.addEventListener('keydown', function (event) {
      if (event.key !== 'Tab') return;
      var focusable = qsa('button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])', container).filter(function (el) {
        return !el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.offsetParent !== null;
      });
      if (focusable.length === 0) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  function wire() {
    qsa('[data-testid="proto-place-node"]').forEach(function (node) {
      node.addEventListener('click', function () {
        navigateTo(node.getAttribute('data-place-id'));
      });
    });

    qsa('[data-testid="proto-root-alias"]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        handleAlias(chip.getAttribute('data-verb-id'));
      });
    });

    askEntry.addEventListener('click', function () {
      openLauncher('natural');
    });

    mapEntry.addEventListener('click', function () {
      openMap();
    });

    mapClose.addEventListener('click', function () {
      closeMap();
    });

    mapOverlay.addEventListener('click', function (event) {
      var row = event.target.closest('[data-testid="proto-map-key"]');
      if (!row) return;
      var verbId = row.getAttribute('data-verb-id');
      var group = row.closest('[data-testid="proto-map-group"]');
      var groupPlace = group ? group.getAttribute('data-place-id') : 'place.canvas';
      closeMap(true);
      if (verbId === 'verb.ask.open') {
        openLauncher('natural');
        return;
      }
      if (verbId === 'verb.map.open') {
        openMap();
        return;
      }
      var owner = groupPlace === 'place.aliases' ? aliasOwner(verbId) : groupPlace;
      navigateTo(owner, verbId);
      var target = rail.querySelector('[data-testid="proto-verb"][data-verb-id="' + verbId + '"]');
      if (target) {
        target.focus();
      } else {
        var crumb = rail.querySelector('[data-testid="proto-breadcrumb-crumb"][aria-current="page"]');
        if (crumb) crumb.focus();
      }
    });

    sendButton.addEventListener('click', submitNatural);

    browseButton.addEventListener('click', function () {
      launcherInput.value = '';
      setLauncherMode('palette');
      renderPalette('');
      launcherInput.focus();
    });

    launcherInput.addEventListener('input', handleLauncherInput);
    launcherInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && launcherMode() === 'natural') {
        event.preventDefault();
        submitNatural();
      }
    });

    undoAction.addEventListener('click', applyUndo);

    qsa('.swatch').forEach(function (swatch) {
      swatch.addEventListener('click', function () {
        var ids = selectedIds();
        if (ids.length !== 1) {
          note('Select one element to change its fill.');
          return;
        }
        var el = objectById(ids[0]);
        el.setAttribute('data-fill', swatch.getAttribute('data-fill'));
        renderObjectFill(el);
        note('Fill set to ' + fillLabel(swatch.getAttribute('data-fill')) + '.');
      });
    });

    canvas.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return;
      if (event.target !== canvas && event.target !== emptyNote) return;
      var rect = canvas.getBoundingClientRect();
      var startX = event.clientX - rect.left;
      var startY = event.clientY - rect.top;
      var box = document.createElement('div');
      box.className = 'marquee';
      box.style.left = startX + 'px';
      box.style.top = startY + 'px';
      box.style.width = '0px';
      box.style.height = '0px';
      canvas.appendChild(box);
      var moved = false;

      function move(moveEvent) {
        var x = moveEvent.clientX - rect.left;
        var y = moveEvent.clientY - rect.top;
        var width = Math.abs(x - startX);
        var height = Math.abs(y - startY);
        if (width > 4 || height > 4) moved = true;
        box.style.left = Math.min(startX, x) + 'px';
        box.style.top = Math.min(startY, y) + 'px';
        box.style.width = width + 'px';
        box.style.height = height + 'px';
      }

      function stop() {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', stop);
        var left = parseFloat(box.style.left) || 0;
        var top = parseFloat(box.style.top) || 0;
        var right = left + (parseFloat(box.style.width) || 0);
        var bottom = top + (parseFloat(box.style.height) || 0);
        box.remove();
        if (!moved) {
          clearSelection();
          return;
        }
        var ids = state.objects.filter(function (el) {
          var elLeft = parseFloat(el.style.left) || 0;
          var elTop = parseFloat(el.style.top) || 0;
          var elRight = elLeft + el.offsetWidth;
          var elBottom = elTop + el.offsetHeight;
          return elLeft < right && elRight > left && elTop < bottom && elBottom > top;
        }).map(function (el) {
          return el.getAttribute('data-object-id');
        });
        state.selection = new Set(ids);
        updateSelection();
      }

      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', stop);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (launcherOpen()) {
          event.preventDefault();
          launcherEscape();
          return;
        }
        if (mapOpen()) {
          event.preventDefault();
          closeMap();
          return;
        }
        return;
      }
      if (launcherOpen() || mapOpen()) return;
      var target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (event.key === '?') {
        event.preventDefault();
        openMap();
        return;
      }
      if (event.key === '/') {
        event.preventDefault();
        openLauncher('natural');
        return;
      }
      var key = event.key;
      if (!/^[a-z0-9]$/.test(key)) return;
      var button = rail.querySelector('[data-testid="proto-verb"][data-key="' + key + '"]');
      if (button && button.getAttribute('data-disabled') !== 'true') {
        event.preventDefault();
        executeVerb(button.getAttribute('data-verb-id'));
      }
    });

    trapFocus(mapOverlay.querySelector('.map-panel'));
    trapFocus(launcherPanel);
  }

  renderRailVerbs('place.canvas');
  renderBreadcrumb('place.canvas');
  updateTreeActive('place.canvas');
  updateScope();
  updateSelection();
  updateEmptyNote();
  swatches.hidden = true;
  wire();
})();
