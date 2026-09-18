const assert = require('node:assert/strict');

global.window = global;
require('../src/audio-engine.js');

function makeClickTrack({ bpm = 120, duration = 20, sampleRate = 44100 } = {}) {
  const data = new Float32Array(Math.round(duration * sampleRate));
  const beatDuration = 60 / bpm;
  for (let i = 0; i < data.length; i += 1) {
    const time = i / sampleRate;
    const beat = Math.floor(time / beatDuration);
    const phase = time % beatDuration;
    const envelope = phase < 0.025 ? Math.exp(-phase * 120) : 0;
    const frequency = beat % 4 === 0 ? 120 : 700;
    const accent = beat % 4 === 0 ? 0.9 : 0.55;
    data[i] = envelope * Math.sin(2 * Math.PI * frequency * time) * accent;
  }
  return {
    sampleRate,
    duration,
    length: data.length,
    numberOfChannels: 1,
    getChannelData: () => data
  };
}

function makeMockAnalysis(barCount = 32) {
  const chroma = new Float32Array(barCount * 12);
  for (let bar = 0; bar < barCount; bar += 1) chroma[bar * 12 + (bar % 8 < 4 ? 0 : 7)] = 1;
  return {
    bpm: 120,
    beatDuration: 0.5,
    barDuration: 2,
    barCount,
    barPhaseSeconds: 0.12,
    barEnergy: Float32Array.from({ length: barCount }, (_, i) => i % 16 < 8 ? 0.35 : 0.85),
    barOnset: Float32Array.from({ length: barCount }, (_, i) => i % 16 < 8 ? 0.3 : 0.8),
    barChroma: chroma,
    barCentroid: Float32Array.from({ length: barCount }, (_, i) => i % 16 < 8 ? 0.4 : 0.7),
    vocalActivity: Float32Array.from({ length: 640 }, () => 0.1),
    vocalSecondsPerFrame: 0.1,
    beatsPerBar: 4
  };
}

async function run() {
  const clickTrack = makeClickTrack();
  const detected = await VistaAudio.analyze(clickTrack);
  assert.ok(Math.abs(detected.bpm - 120) <= 2, `预期约 120 BPM，实际 ${detected.bpm}`);
  assert.equal(detected.beatsPerBar, 4, '预期识别为 4/4 拍');

  const analysis = makeMockAnalysis();
  const sections = VistaAudio.buildSections(analysis, 64);
  assert.ok(sections.length >= 3, '应生成多个歌曲结构段落');

  const sampleRate = 1000;
  const data = Float32Array.from({ length: 64000 }, (_, i) => Math.sin(i * 0.05) * 0.2);
  const buffer = {
    sampleRate,
    duration: 64,
    length: data.length,
    numberOfChannels: 1,
    getChannelData: () => data
  };
  const { results } = await VistaAudio.process(
    buffer,
    30,
    'all',
    () => {},
    analysis,
    sections.map(section => ({ ...section, selected: true }))
  );
  assert.equal(results.length, 3, '应生成三套候选方案');
  results.forEach(result => {
    const outputSeconds = (result.wavBytes.length - 44) / 2 / sampleRate;
    assert.ok(Math.abs(outputSeconds - result.targetSeconds) <= 0.002, `文件时长应与自然成片时长一致，实际 ${outputSeconds}`);
    assert.ok(result.waveformPeaks.length > 100, '拼接结果应携带成品峰值数据供时间线准确绘制');
    assert.ok(Math.abs(outputSeconds - 30) <= 10, `自然成片应保持在参考时长附近，实际 ${outputSeconds}`);
    assert.equal(result.requestedSeconds, 30, '应保留用户输入的参考时长');
    assert.equal(result.lyricsProtected, true, '候选方案应启用歌词气口保护');
    if (result.cutCount > 0) {
      assert.ok(result.crossfadeSeconds >= 0.2 && result.crossfadeSeconds < analysis.beatDuration, '接点应采用不足一拍的 A/B 轨交叉淡化');
    }
    for (let i = 1; i < result.segments.length; i += 1) {
      assert.ok(result.segments[i].start >= result.segments[i - 1].start, '片段必须保持原曲时间顺序');
    }
  });

  const exactRanges = [
    { start: 0, end: 15, label: '片段 1', type: 'verse' },
    { start: 30, end: 45, label: '片段 2', type: 'chorus' }
  ];
  const exact = await VistaAudio.process(buffer, 30, 'balanced', () => {}, analysis, exactRanges);
  const exactSeconds = (exact.results[0].wavBytes.length - 44) / 2 / sampleRate;
  assert.ok(Math.abs(exactSeconds - exact.results[0].targetSeconds) <= 0.002, '文件时长应与方案显示时长一致');
  assert.ok(Math.abs(exactSeconds - 30) <= 1, '完整乐段方案应保持在参考时长附近');

  const naturalTail = await VistaAudio.process(buffer, 20, 'smooth', () => {}, analysis, [
    { start: 0, end: 10, label: '副歌', type: 'chorus' },
    { start: 10, end: 15, label: '过渡', type: 'bridge' },
    { start: 15, end: 25, label: '尾奏', type: 'outro' }
  ]);
  assert.equal(naturalTail.results[0].cutCount, 0, '连续的高潮、过渡和尾奏不得重新制造切点');
  assert.ok(Math.abs(naturalTail.results[0].targetSeconds - 25) <= 0.002, '自然尾段应完整保留而不是硬裁到参考时长');

  const narrativeRanges = [
    { start: 0, end: 8, label: '前奏', type: 'intro' },
    { start: 10, end: 24, label: '主歌 1', type: 'verse' },
    { start: 28, end: 42, label: '副歌 1', type: 'chorus' },
    { start: 44, end: 52, label: '间奏', type: 'interlude' },
    { start: 56, end: 64, label: '尾奏', type: 'outro' }
  ];
  const narrative = await VistaAudio.process(buffer, 30, 'all', () => {}, analysis, narrativeRanges);
  narrative.results.forEach(result => {
    assert.equal(result.narrativeArc, true, '完整结构可用时必须采用五段迷你歌曲规划');
    assert.equal(result.segments.length, 5, '前奏、主歌、副歌、间奏、尾奏都应出现在方案中');
    assert.deepEqual(result.segments.map(segment => segment.role), narrativeRanges.map(range => range.label), '五段顺序必须保持不变');
    assert.ok(result.segments[0].start < 1, '方案必须从原曲前奏起步，不能从歌曲后半段开始');
  });

  console.log('audio-engine: 5 项回归测试通过');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
