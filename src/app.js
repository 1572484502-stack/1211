(() => {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const state = { file: null, buffer: null, analysis: null, sections: [], sourceUrl: null, resultUrls: [], results: [] };
  const HISTORY_KEY = 'history.v1';
  const typeColors = { verse: '#7e7ce6', lift: '#b16eed', chorus: '#ef6868', outro: '#8996a8' };

  const dropZone = $('#dropZone');
  const fileInput = $('#fileInput');
  const workbench = $('#musicWorkbench');
  const sourceAudio = $('#sourceAudio');
  let sourceAnimationFrame = 0;
  window.VistaMedia.register(sourceAudio, 'music');

  function formatTime(seconds) {
    const safe = Math.max(0, Math.round(seconds));
    return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
  }

  function formatBytes(bytes) {
    return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function showToast(message, type = 'success') {
    const toast = $('#toast');
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 3000);
  }

  function readHistory() {
    const records = window.VistaStore.read('music', HISTORY_KEY, null);
    if (records) return records;
    try {
      const legacy = JSON.parse(localStorage.getItem('vistaStudio.musicHistory.v1') || '[]');
      if (legacy.length) writeHistory(legacy);
      return legacy;
    } catch { return []; }
  }

  function writeHistory(records) {
    window.VistaStore.write('music', HISTORY_KEY, records.slice(0, 20));
  }

  function renderHistory() {
    const list = $('#historyList');
    const records = readHistory();
    list.replaceChildren();
    if (!records.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.innerHTML = '<span>◷</span><strong>还没有生成记录</strong><p>生成候选方案后，任务信息会保存在这里。</p>';
      list.appendChild(empty);
      $('#clearHistoryBtn').disabled = true;
      return;
    }
    $('#clearHistoryBtn').disabled = false;
    records.forEach(record => {
      const item = document.createElement('article');
      item.className = 'history-item';
      const title = document.createElement('strong');
      title.textContent = record.fileName;
      const meta = document.createElement('p');
      meta.textContent = `${record.date} · 目标 ${formatTime(record.target)} · ${record.selectedCount} 个所选段落`;
      const badge = document.createElement('span');
      badge.textContent = `${record.candidateCount} 个方案`;
      item.append(title, meta, badge);
      list.appendChild(item);
    });
  }

  function addHistoryRecord(candidateCount) {
    if (!state.file) return;
    const records = readHistory();
    records.unshift({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      date: new Date().toLocaleString('zh-CN', { hour12: false }),
      fileName: state.file.name,
      target: getTargetSeconds(),
      selectedCount: selectedRanges().length,
      candidateCount
    });
    writeHistory(records);
    renderHistory();
  }

  function setHistoryOpen(open) {
    if (open) pauseAllAudio();
    $('#historyDrawer').classList.toggle('open', open);
    $('#historyDrawer').setAttribute('aria-hidden', String(!open));
    $('#drawerBackdrop').classList.toggle('hidden', !open);
    if (open) renderHistory();
  }

  function switchPanel(panel) {
    if (!state.buffer) {
      showToast('请先上传一首音乐。', 'error');
      return;
    }
    pauseAllAudio();
    const analysis = panel === 'analysis';
    $('#analysisPanel').classList.toggle('hidden', !analysis);
    $('#retargetPanel').classList.toggle('hidden', analysis);
    $('#analysisTab').classList.toggle('active', analysis);
    $('#retargetTab').classList.toggle('active', !analysis);
    requestAnimationFrame(() => {
      if (analysis) drawWaveform($('#waveform'), state.buffer, state.sections);
      else drawWaveform($('#retargetWaveform'), state.buffer, state.sections, true);
    });
  }

  $('#analysisTab').addEventListener('click', () => switchPanel('analysis'));
  $('#retargetTab').addEventListener('click', () => switchPanel('retarget'));
  $('#goRetargetBtn').addEventListener('click', () => switchPanel('retarget'));
  $('#historyBtn').addEventListener('click', () => setHistoryOpen(true));
  $('#closeHistoryBtn').addEventListener('click', () => setHistoryOpen(false));
  $('#drawerBackdrop').addEventListener('click', () => setHistoryOpen(false));
  $('#clearHistoryBtn').addEventListener('click', () => {
    if (!window.confirm('确定清空所有本地历史记录吗？')) return;
    writeHistory([]);
    renderHistory();
    showToast('历史记录已清空。');
  });

  function buildSections(analysis, duration) {
    const barsPerSection = duration > 150 ? 8 : 4;
    const phraseDuration = analysis.barDuration * barsPerSection;
    const origin = analysis.barPhaseSeconds || 0;
    const sections = [];
    let start = 0;
    let end = Math.min(duration, Math.max(phraseDuration, origin + phraseDuration));
    while (start < duration - 0.05) {
      const startBar = Math.max(0, Math.floor((start - origin) / analysis.barDuration));
      const endBar = Math.min(analysis.barCount, Math.ceil((end - origin) / analysis.barDuration));
      let energy = 0;
      for (let i = startBar; i < endBar; i += 1) energy += analysis.barEnergy[i] || 0;
      energy /= Math.max(1, endBar - startBar);
      const progress = start / duration;
      let type = 'verse';
      let label = '主歌';
      if (sections.length === 0) label = '前奏';
      else if (progress > .84) { type = 'outro'; label = '尾奏'; }
      else if (energy > .72) { type = 'chorus'; label = '高潮'; }
      else if (energy > .49) { type = 'lift'; label = '推进'; }
      else if (energy < .3) label = '间奏';
      sections.push({
        start,
        end,
        type,
        label,
        energy,
        selected: true
      });
      start = end;
      end = Math.min(duration, end + phraseDuration);
    }
    if (sections.length) {
      sections[0].start = 0;
      sections[sections.length - 1].end = duration;
      sections[sections.length - 1].type = 'outro';
      sections[sections.length - 1].label = '尾奏';
    }
    return sections;
  }

  function renderSegmentBand(target, sections, duration, showLabels = true) {
    target.replaceChildren();
    sections.forEach((section, index) => {
      const block = document.createElement('button');
      block.type = 'button';
      block.className = `segment-block ${section.type} ${section.selected ? 'selected' : 'unselected'}`;
      block.style.flex = `${Math.max(.01, (section.end - section.start) / duration)} 1 0`;
      block.textContent = showLabels ? section.label : '';
      block.title = `${section.selected ? '已选中' : '已排除'} · ${section.label} ${formatTime(section.start)}–${formatTime(section.end)}`;
      block.setAttribute('aria-pressed', String(section.selected));
      block.addEventListener('click', () => {
        state.sections[index].selected = !state.sections[index].selected;
        syncSelectionUI();
      });
      target.appendChild(block);
    });
  }

  function selectedRanges() {
    return state.sections
      .filter(section => section.selected)
      .map(section => ({ start: section.start, end: section.end, label: section.label, type: section.type }));
  }

  function syncSelectionUI() {
    if (!state.buffer) return;
    renderSegmentBand($('#segmentBand'), state.sections, state.buffer.duration, true);
    renderSegmentBand($('#retargetSegmentBand'), state.sections, state.buffer.duration, false);
    const count = selectedRanges().length;
    $('#selectedCount').textContent = count;
    $('#analyzeBtn').disabled = count === 0;
    requestAnimationFrame(() => {
      drawWaveform($('#waveform'), state.buffer, state.sections);
      drawWaveform($('#retargetWaveform'), state.buffer, state.sections, true);
    });
  }

  function drawWaveform(canvas, buffer, sections, compact = false) {
    if (!canvas || canvas.offsetParent === null) return;
    const rect = canvas.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * pixelRatio));
    canvas.height = Math.max(1, Math.floor(rect.height * pixelRatio));
    const ctx = canvas.getContext('2d');
    ctx.scale(pixelRatio, pixelRatio);
    const width = rect.width;
    const height = rect.height;
    ctx.clearRect(0, 0, width, height);

    sections.forEach((section, index) => {
      const startX = (section.start / buffer.duration) * width;
      const endX = (section.end / buffer.duration) * width;
      ctx.fillStyle = section.selected ? `${typeColors[section.type]}12` : 'rgba(139, 138, 151, .12)';
      ctx.fillRect(startX, 0, endX - startX, height);
      if (index > 0) {
        ctx.save();
        ctx.setLineDash([3, 5]);
        ctx.strokeStyle = section.selected ? `${typeColors[section.type]}aa` : 'rgba(145, 143, 157, .7)';
        ctx.beginPath(); ctx.moveTo(startX, 0); ctx.lineTo(startX, height); ctx.stroke();
        ctx.restore();
      }
      if (!compact && endX - startX > 43) {
        ctx.fillStyle = '#726d89';
        ctx.font = '11px "Microsoft YaHei UI"';
        ctx.fillText(section.label, startX + 5, 13);
      }
    });

    const data = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / width));
    const center = height / 2 + (compact ? 0 : 6);
    const maxAmp = height * (compact ? .42 : .37);
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#7c3cff');
    gradient.addColorStop(.5, '#b47aff');
    gradient.addColorStop(1, '#7c3cff');
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < width; x += 1) {
      const start = Math.floor(x * step);
      let peak = 0;
      const sampleStride = Math.max(1, Math.floor(step / 36));
      for (let i = 0; i < step; i += sampleStride) peak = Math.max(peak, Math.abs(data[start + i] || 0));
      const amplitude = Math.max(1, peak * maxAmp);
      ctx.moveTo(x + .5, center - amplitude);
      ctx.lineTo(x + .5, center + amplitude);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(124,60,255,.14)';
    ctx.beginPath(); ctx.moveTo(0, center); ctx.lineTo(width, center); ctx.stroke();

    sections.filter(section => !section.selected).forEach(section => {
      const startX = (section.start / buffer.duration) * width;
      const endX = (section.end / buffer.duration) * width;
      ctx.fillStyle = 'rgba(238, 238, 244, .68)';
      ctx.fillRect(startX, 0, endX - startX, height);
    });

    if (sourceAudio.src) {
      const playheadX = Math.max(0, Math.min(width, (sourceAudio.currentTime / Math.max(.001, buffer.duration)) * width));
      ctx.strokeStyle = '#5f24e8';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(playheadX, 0); ctx.lineTo(playheadX, height); ctx.stroke();
      ctx.fillStyle = '#5f24e8';
      ctx.beginPath(); ctx.moveTo(playheadX - 5, 0); ctx.lineTo(playheadX + 5, 0); ctx.lineTo(playheadX, 7); ctx.closePath(); ctx.fill();
    }
  }

  function populateAnalysis() {
    const { analysis, buffer } = state;
    $('#metricBpm').textContent = analysis.bpm.toFixed(0);
    $('#metricDuration').textContent = formatTime(buffer.duration);
    $('#metricBars').textContent = analysis.barCount;
    $('#metricChannels').textContent = buffer.numberOfChannels > 1 ? '立体声' : '单声道';
    $('#metricSampleRate').textContent = `${(buffer.sampleRate / 1000).toFixed(1)} kHz 采样率`;
    $('#trackDuration').textContent = formatTime(buffer.duration);
    $('#time25').textContent = formatTime(buffer.duration * .25);
    $('#time50').textContent = formatTime(buffer.duration * .5);
    $('#time75').textContent = formatTime(buffer.duration * .75);
    $('#sourceDurationLabel').textContent = formatTime(buffer.duration);
    syncSelectionUI();
    requestAnimationFrame(() => drawWaveform($('#waveform'), buffer, state.sections));
  }

  async function loadFile(file) {
    if (!file || (!file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(file.name))) {
      showToast('请选择受支持的音频文件。', 'error');
      return;
    }
    try {
      pauseAllAudio();
      dropZone.classList.add('hidden');
      workbench.classList.add('hidden');
      $('#fileBar').classList.remove('hidden');
      $('#loadingPanel').classList.remove('hidden');
      $('#trackName').textContent = file.name.replace(/\.[^.]+$/, '');
      $('#trackInfo').textContent = '正在读取并分析…';
      const buffer = await window.VistaAudio.decodeFile(file);
      state.file = file;
      state.buffer = buffer;
      $('#trackInfo').textContent = `${formatBytes(file.size)} · ${(buffer.sampleRate / 1000).toFixed(1)} kHz · ${buffer.numberOfChannels > 1 ? '立体声' : '单声道'}`;

      await new Promise(resolve => requestAnimationFrame(() => resolve()));
      const analysis = window.VistaAudio.analyze(buffer, (percent, detail) => {
        $('#loadingPercent').textContent = `${Math.min(96, Math.round(percent * 2.3))}%`;
        $('#loadingDetail').textContent = detail;
      });
      state.analysis = analysis;
      state.sections = buildSections(analysis, buffer.duration);

      if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
      state.sourceUrl = URL.createObjectURL(file);
      sourceAudio.src = state.sourceUrl;
      $('#loadingPercent').textContent = '100%';
      $('#loadingDetail').textContent = '结构分析完成';
      populateAnalysis();
      setTimeout(() => {
        $('#loadingPanel').classList.add('hidden');
        workbench.classList.remove('hidden');
        switchPanel('analysis');
      }, 180);
      showToast(`分析完成：检测到约 ${analysis.bpm} BPM。`);
    } catch (error) {
      $('#loadingPanel').classList.add('hidden');
      $('#fileBar').classList.add('hidden');
      dropZone.classList.remove('hidden');
      showToast(`音频读取失败：${error.message}`, 'error');
    }
  }

  $('#chooseFileBtn').addEventListener('click', event => { event.stopPropagation(); pauseAllAudio(); fileInput.click(); });
  $('#replaceBtn').addEventListener('click', () => { pauseAllAudio(); fileInput.click(); });
  dropZone.addEventListener('click', () => { pauseAllAudio(); fileInput.click(); });
  fileInput.addEventListener('change', () => loadFile(fileInput.files[0]));
  dropZone.addEventListener('dragover', event => { event.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', event => { event.preventDefault(); dropZone.classList.remove('dragover'); loadFile(event.dataTransfer.files[0]); });

  $('#sourcePlayBtn').addEventListener('click', async () => {
    if (!sourceAudio.src) return;
    if (sourceAudio.paused) await sourceAudio.play(); else sourceAudio.pause();
  });
  function pauseOtherAudio(activeAudio) {
    window.VistaMedia.playExclusive(activeAudio);
  }

  function pauseAllAudio() {
    window.VistaMedia.pauseScope('music');
  }

  function animateSourcePlayhead() {
    $('#sourceTime').textContent = formatTime(sourceAudio.currentTime);
    drawWaveform($('#waveform'), state.buffer, state.sections);
    drawWaveform($('#retargetWaveform'), state.buffer, state.sections, true);
    if (!sourceAudio.paused && !sourceAudio.ended) sourceAnimationFrame = requestAnimationFrame(animateSourcePlayhead);
  }

  sourceAudio.addEventListener('play', () => {
    pauseOtherAudio(sourceAudio);
    $('#sourcePlayBtn').firstChild.textContent = '❚❚ ';
    cancelAnimationFrame(sourceAnimationFrame);
    sourceAnimationFrame = requestAnimationFrame(animateSourcePlayhead);
  });
  sourceAudio.addEventListener('pause', () => {
    $('#sourcePlayBtn').firstChild.textContent = '▶ ';
    cancelAnimationFrame(sourceAnimationFrame);
  });
  sourceAudio.addEventListener('timeupdate', () => {
    $('#sourceTime').textContent = formatTime(sourceAudio.currentTime);
    drawWaveform($('#waveform'), state.buffer, state.sections);
    drawWaveform($('#retargetWaveform'), state.buffer, state.sections, true);
  });
  $('#zoomBtn').addEventListener('click', () => showToast('波形缩放将在精细时间线版本中开放。'));

  function seekSourceFromWaveform(canvas, event) {
    if (!state.buffer) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    sourceAudio.currentTime = ratio * state.buffer.duration;
    sourceAudio.play().catch(() => {});
    drawWaveform(canvas, state.buffer, state.sections, canvas.id === 'retargetWaveform');
  }

  [$('#waveform'), $('#retargetWaveform')].forEach(canvas => {
    let dragging = false;
    canvas.classList.add('seekable-waveform');
    canvas.title = '点击波形可跳转并播放';
    canvas.addEventListener('pointerdown', event => {
      dragging = true;
      canvas.setPointerCapture(event.pointerId);
      seekSourceFromWaveform(canvas, event);
    });
    canvas.addEventListener('pointermove', event => { if (dragging) seekSourceFromWaveform(canvas, event); });
    canvas.addEventListener('pointerup', () => { dragging = false; });
    canvas.addEventListener('pointercancel', () => { dragging = false; });
  });
  $('#selectAllBtn').addEventListener('click', () => {
    state.sections.forEach(section => { section.selected = true; });
    syncSelectionUI();
  });
  $('#clearSelectionBtn').addEventListener('click', () => {
    state.sections.forEach(section => { section.selected = false; });
    syncSelectionUI();
  });

  function getTargetSeconds() {
    return Number($('#targetMinutes').value || 0) * 60 + Number($('#targetSeconds').value || 0);
  }
  function updateTargetLabel() { $('#targetDurationLabel').textContent = formatTime(getTargetSeconds()); }
  $$('.preset-row button').forEach(button => button.addEventListener('click', () => {
    const seconds = Number(button.dataset.seconds);
    $('#targetMinutes').value = Math.floor(seconds / 60);
    $('#targetSeconds').value = seconds % 60;
    $$('.preset-row button').forEach(item => item.classList.toggle('active', item === button));
    updateTargetLabel();
  }));
  $$('.duration-control input').forEach(input => input.addEventListener('input', () => {
    if (input.id === 'targetSeconds' && Number(input.value) > 59) input.value = 59;
    if (Number(input.value) < 0) input.value = 0;
    $$('.preset-row button').forEach(item => item.classList.remove('active'));
    updateTargetLabel();
  }));

  function setProgress(percent, detail) {
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    $('#progressPercent').textContent = `${value}%`;
    $('#progressBar').style.width = `${value}%`;
    $('#progressDetail').textContent = detail;
    const completed = value >= 100;
    $('#progressPanel').classList.toggle('complete', completed);
    if (completed) $('#progressTitle').textContent = '候选方案已生成';
  }

  function clearResultUrls() {
    $$('#resultsGrid audio').forEach(audio => window.VistaMedia.unregister(audio));
    state.resultUrls.forEach(url => URL.revokeObjectURL(url));
    state.resultUrls = [];
  }

  function segmentText(segments) {
    return segments.map(segment => `${segment.role} ${formatTime(segment.start)}–${formatTime(segment.end)}`).join('　');
  }

  function prepareWaveCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, rect.width, rect.height);
    return { ctx, width: rect.width, height: rect.height };
  }

  function strokeWaveRange(ctx, data, sampleRate, sourceStart, sourceEnd, xStart, xEnd, center, amplitude, color) {
    const pixelWidth = Math.max(1, Math.floor(xEnd - xStart));
    const firstFrame = Math.max(0, Math.floor(sourceStart * sampleRate));
    const lastFrame = Math.min(data.length, Math.ceil(sourceEnd * sampleRate));
    const framesPerPixel = Math.max(1, Math.floor((lastFrame - firstFrame) / pixelWidth));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let pixel = 0; pixel < pixelWidth; pixel += 1) {
      const from = firstFrame + pixel * framesPerPixel;
      const to = Math.min(lastFrame, from + framesPerPixel);
      let peak = 0;
      const sampleStride = Math.max(1, Math.floor((to - from) / 36));
      for (let frame = from; frame < to; frame += sampleStride) peak = Math.max(peak, Math.abs(data[frame] || 0));
      const value = Math.max(1, peak * amplitude);
      const x = xStart + pixel + 0.5;
      ctx.moveTo(x, center - value);
      ctx.lineTo(x, center + value);
    }
    ctx.stroke();
  }

  function sectionForTime(time) {
    return state.sections.find(section => time >= section.start - 0.02 && time < section.end + 0.02) || state.sections[0];
  }

  function drawSourceCuts(canvas, result) {
    if (!canvas || !state.buffer) return;
    const { ctx, width, height } = prepareWaveCanvas(canvas);
    const data = state.buffer.getChannelData(0);
    const center = height / 2;
    ctx.fillStyle = '#f6f5fa';
    ctx.fillRect(0, 0, width, height);
    strokeWaveRange(ctx, data, state.buffer.sampleRate, 0, state.buffer.duration, 0, width, center, height * .35, '#c0bdca');

    result.segments.forEach((segment, index) => {
      const xStart = (segment.start / state.buffer.duration) * width;
      const xEnd = (segment.end / state.buffer.duration) * width;
      const section = sectionForTime(segment.start);
      const color = typeColors[section?.type] || '#7e7ce6';
      ctx.fillStyle = `${color}24`;
      ctx.fillRect(xStart, 0, Math.max(2, xEnd - xStart), height);
      strokeWaveRange(ctx, data, state.buffer.sampleRate, segment.start, segment.end, xStart, xEnd, center, height * .38, color);
      ctx.fillStyle = color;
      ctx.fillRect(xStart, 0, 2, height);
      ctx.font = '700 10px "Microsoft YaHei UI"';
      ctx.fillText(String(index + 1), Math.min(width - 13, xStart + 5), 12);
    });
  }

  function drawArrangementResult(canvas, result, currentTime = 0) {
    if (!canvas || !state.buffer) return;
    const { ctx, width, height } = prepareWaveCanvas(canvas);
    const data = state.buffer.getChannelData(0);
    const total = result.segments.reduce((sum, segment) => sum + segment.end - segment.start, 0) || 1;
    const center = height / 2;
    let cursor = 0;
    ctx.fillStyle = '#f8f6ff';
    ctx.fillRect(0, 0, width, height);

    result.segments.forEach((segment, index) => {
      const segmentWidth = ((segment.end - segment.start) / total) * width;
      const xEnd = index === result.segments.length - 1 ? width : cursor + segmentWidth;
      const section = sectionForTime(segment.start);
      const color = typeColors[section?.type] || '#7e7ce6';
      ctx.fillStyle = `${color}20`;
      ctx.fillRect(cursor, 0, Math.max(2, xEnd - cursor), height);
      strokeWaveRange(ctx, data, state.buffer.sampleRate, segment.start, segment.end, cursor, xEnd, center, height * .36, color);
      if (index > 0) {
        const overlapWidth = Math.max(5, (result.crossfadeSeconds / result.targetSeconds) * width);
        ctx.fillStyle = 'rgba(255,255,255,.78)';
        ctx.fillRect(cursor - overlapWidth / 2, 0, overlapWidth, height);
        ctx.strokeStyle = '#7c3cff';
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(cursor, 0); ctx.lineTo(cursor, height); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = color;
      ctx.font = '700 10px "Microsoft YaHei UI"';
      ctx.fillText(`${index + 1} ${segment.role}`, cursor + 6, height - 7);
      cursor = xEnd;
    });

    const playheadX = Math.max(0, Math.min(width, (currentTime / Math.max(.001, result.targetSeconds)) * width));
    ctx.strokeStyle = '#5f24e8';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(playheadX, 0); ctx.lineTo(playheadX, height); ctx.stroke();
    ctx.fillStyle = '#5f24e8';
    ctx.beginPath(); ctx.moveTo(playheadX - 5, 0); ctx.lineTo(playheadX + 5, 0); ctx.lineTo(playheadX, 7); ctx.closePath(); ctx.fill();
  }

  function drawResultWaveforms(card, result) {
    drawSourceCuts(card.querySelector('.result-source-wave'), result);
    const audio = card.querySelector('audio');
    drawArrangementResult(card.querySelector('.result-output-wave'), result, audio?.currentTime || 0);
  }

  function bindResultPlayback(card, result) {
    const audio = card.querySelector('audio');
    const canvas = card.querySelector('.result-output-wave');
    const currentLabel = card.querySelector('.playback-current');
    let dragging = false;
    let animationFrame = 0;

    const redraw = () => {
      currentLabel.textContent = formatTime(audio.currentTime);
      canvas.setAttribute('aria-valuenow', String(Math.round(audio.currentTime)));
      drawArrangementResult(canvas, result, audio.currentTime);
    };
    const seek = event => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
      audio.currentTime = ratio * result.targetSeconds;
      canvas.setAttribute('aria-valuenow', String(Math.round(audio.currentTime)));
      redraw();
    };
    const animate = () => {
      redraw();
      if (!audio.paused && !audio.ended) animationFrame = requestAnimationFrame(animate);
    };

    canvas.addEventListener('pointerdown', event => {
      dragging = true;
      canvas.setPointerCapture(event.pointerId);
      seek(event);
    });
    canvas.addEventListener('pointermove', event => { if (dragging) seek(event); });
    canvas.addEventListener('pointerup', event => {
      if (!dragging) return;
      dragging = false;
      seek(event);
      audio.play().catch(() => {});
    });
    canvas.addEventListener('pointercancel', () => { dragging = false; });
    canvas.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', ' ', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
      else if (event.key === 'ArrowRight') audio.currentTime = Math.min(result.targetSeconds, audio.currentTime + 5);
      else if (audio.paused) audio.play().catch(() => {}); else audio.pause();
      redraw();
    });
    audio.addEventListener('play', () => {
      pauseOtherAudio(audio);
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(animate);
    });
    audio.addEventListener('pause', () => { cancelAnimationFrame(animationFrame); redraw(); });
    audio.addEventListener('ended', () => { cancelAnimationFrame(animationFrame); redraw(); });
    audio.addEventListener('seeked', redraw);
  }

  function segmentLegend(segments) {
    return segments.map((segment, index) => `<span><b>${index + 1}</b>${segment.role} ${formatTime(segment.start)}–${formatTime(segment.end)}</span>`).join('');
  }

  function renderResults(results) {
    clearResultUrls();
    state.results = results;
    const grid = $('#resultsGrid');
    grid.replaceChildren();
    results.forEach((result, index) => {
      const url = URL.createObjectURL(result.blob);
      state.resultUrls.push(url);
      const card = document.createElement('article');
      card.className = `result-card ${index === 0 ? 'recommended' : ''}`;
      const selectedCount = selectedRanges().length;
      card.innerHTML = `
        <div class="result-top"><span class="result-letter">${String.fromCharCode(65 + index)}</span><div class="result-title"><strong>方案 ${String.fromCharCode(65 + index)} · ${formatTime(result.targetSeconds)}</strong><small>${result.cutCount} 处衔接 · 约 ${result.bpm} BPM</small></div>${index === 0 ? '<span class="recommend-tag">推荐先试听</span>' : ''}</div>
        <div class="result-tags"><span>目标时长已对齐</span><span>强拍对齐切割</span><span>4/8 小节乐句结构</span><span>${result.crossfadeSeconds.toFixed(2)} 秒整拍衔接</span><span>接点响度匹配</span><span>参与范围 ${selectedCount} 段</span></div>
        <div class="wave-compare">
          <div class="result-wave-row"><div class="result-wave-label"><strong>原曲取段</strong><small>灰色为舍弃，彩色为采用</small></div><canvas class="result-source-wave" height="72"></canvas></div>
          <div class="result-wave-row"><div class="result-wave-label"><strong>拼接结果</strong><small>虚线为衔接点，点击或拖动可跳转</small></div><canvas class="result-output-wave" height="72" tabindex="0" role="slider" aria-label="试听进度，点击或拖动跳转" aria-valuemin="0" aria-valuemax="${Math.round(result.targetSeconds)}" aria-valuenow="0"></canvas></div>
          <div class="playback-position"><strong class="playback-current">00:00</strong><span>拖动播放头或点击波形定位</span><strong>${formatTime(result.targetSeconds)}</strong></div>
          <div class="segment-legend">${segmentLegend(result.segments)}</div>
        </div>
        <div class="result-bottom"><audio controls preload="metadata" src="${url}"></audio><div class="result-actions"><button class="detail-btn">查看片段</button><button class="export-btn">导出 WAV</button></div></div>`;
      card.querySelector('.detail-btn').addEventListener('click', () => showToast(segmentText(result.segments)));
      card.querySelector('.export-btn').addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        const oldText = button.textContent;
        button.textContent = '导出中…';
        const baseName = state.file.name.replace(/\.[^.]+$/, '');
        const defaultName = `${baseName}-${Math.round(result.targetSeconds)}秒-方案${String.fromCharCode(65 + index)}.wav`;
        try {
          if (window.vistaDesktop) {
            const response = await window.vistaDesktop.saveWav(result.wavBytes, defaultName);
            if (!response.canceled) showToast(`已导出：${response.filePath}`);
          } else {
            const downloadUrl = URL.createObjectURL(result.blob);
            const anchor = document.createElement('a');
            anchor.href = downloadUrl; anchor.download = defaultName; anchor.click();
            setTimeout(() => URL.revokeObjectURL(downloadUrl), 1500);
            showToast('WAV 文件已保存到下载目录。');
          }
        } catch (error) { showToast(`导出失败：${error.message}`, 'error'); }
        finally { button.disabled = false; button.textContent = oldText; }
      });
      grid.appendChild(card);
      window.VistaMedia.register(card.querySelector('audio'), 'music');
      bindResultPlayback(card, result);
      requestAnimationFrame(() => drawResultWaveforms(card, result));
    });
    $('#resultsSection').classList.remove('hidden');
    addHistoryRecord(results.length);
    setTimeout(() => $('#resultsSection').scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  }

  $('#analyzeBtn').addEventListener('click', async () => {
    const duration = getTargetSeconds();
    $('#analyzeBtn').disabled = true;
    $('#progressPanel').classList.remove('hidden');
    $('#progressPanel').classList.remove('complete');
    $('#resultsSection').classList.add('hidden');
    $('#progressTitle').textContent = '正在生成候选方案';
    setProgress(0, '准备本地音频引擎…');
    try {
      const ranges = selectedRanges();
      if (!ranges.length) throw new Error('请至少选择一个参与重编排的歌曲段落。');
      const output = await window.VistaAudio.process(state.buffer, duration, 'all', setProgress, state.analysis, ranges);
      renderResults(output.results);
      showToast('三个候选版本已经生成。');
    } catch (error) {
      $('#progressPanel').classList.add('hidden');
      showToast(error.message, 'error');
    } finally { $('#analyzeBtn').disabled = selectedRanges().length === 0; }
  });

  window.addEventListener('resize', () => {
    if (!state.buffer) return;
    drawWaveform($('#waveform'), state.buffer, state.sections);
    drawWaveform($('#retargetWaveform'), state.buffer, state.sections, true);
    $$('.result-card').forEach((card, index) => {
      if (state.results[index]) drawResultWaveforms(card, state.results[index]);
    });
  });

  window.VistaCore.registerFeature({
    id: 'music',
    deactivate: pauseAllAudio,
    activate: () => {
      if (!state.buffer) return;
      requestAnimationFrame(() => {
        drawWaveform($('#waveform'), state.buffer, state.sections);
        drawWaveform($('#retargetWaveform'), state.buffer, state.sections, true);
      });
    }
  });
  window.VistaCore.activateFeature('music');
})();
