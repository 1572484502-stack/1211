(() => {
  const STRATEGIES = {
    energy: { name: '方案 A', description: '候选重编排方案。' },
    balanced: { name: '方案 B', description: '候选重编排方案。' },
    smooth: { name: '方案 C', description: '候选重编排方案。' }
  };

  let sharedContext;

  function getAudioContext() {
    if (!sharedContext) sharedContext = new AudioContext();
    return sharedContext;
  }

  async function decodeFile(file) {
    const bytes = await file.arrayBuffer();
    const buffer = await getAudioContext().decodeAudioData(bytes.slice(0));
    return buffer;
  }

  function monoMix(buffer) {
    const mono = new Float32Array(buffer.length);
    const channels = Math.min(buffer.numberOfChannels, 2);
    for (let c = 0; c < channels; c += 1) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i += 1) mono[i] += data[i] / channels;
    }
    return mono;
  }

  function analyzeRhythm(buffer, progress = () => {}) {
    const mono = monoMix(buffer);
    const sampleRate = buffer.sampleRate;
    const frameSize = 2048;
    const hop = 1024;
    const frameCount = Math.max(1, Math.floor((mono.length - frameSize) / hop));
    const rms = new Float32Array(frameCount);

    for (let frame = 0; frame < frameCount; frame += 1) {
      let sum = 0;
      const from = frame * hop;
      for (let i = 0; i < frameSize; i += 1) {
        const value = mono[from + i] || 0;
        sum += value * value;
      }
      rms[frame] = Math.sqrt(sum / frameSize);
      if (frame % 1200 === 0) progress(8 + (frame / frameCount) * 18, '扫描响度与瞬态变化…');
    }

    const onset = new Float32Array(frameCount);
    let onsetMax = 1e-6;
    for (let i = 2; i < frameCount; i += 1) {
      const localMean = (rms[i - 1] + rms[i - 2]) * 0.5;
      onset[i] = Math.max(0, rms[i] - localMean);
      onsetMax = Math.max(onsetMax, onset[i]);
    }
    for (let i = 0; i < frameCount; i += 1) onset[i] /= onsetMax;

    const framesPerSecond = sampleRate / hop;
    let bestBpm = 120;
    let bestScore = -Infinity;
    for (let bpm = 70; bpm <= 180; bpm += 1) {
      const lag = Math.max(1, Math.round((60 / bpm) * framesPerSecond));
      let score = 0;
      for (let i = lag; i < frameCount; i += 1) score += onset[i] * onset[i - lag];
      const centerBias = 1 - Math.abs(bpm - 118) / 700;
      score *= centerBias;
      if (score > bestScore) {
        bestScore = score;
        bestBpm = bpm;
      }
    }

    const beatFrames = (60 / bestBpm) * framesPerSecond;
    const phaseLimit = Math.max(1, Math.round(beatFrames));
    let phase = 0;
    let phaseScore = -1;
    for (let offset = 0; offset < phaseLimit; offset += 1) {
      let score = 0;
      for (let p = offset; p < frameCount; p += beatFrames) score += onset[Math.round(p)] || 0;
      if (score > phaseScore) {
        phaseScore = score;
        phase = offset;
      }
    }

    const beatDuration = 60 / bestBpm;
    const barDuration = beatDuration * 4;
    const beatAccentTotals = [0, 0, 0, 0];
    const beatAccentCounts = [0, 0, 0, 0];
    let beatIndex = 0;
    for (let position = phase; position < frameCount; position += beatFrames) {
      const frame = Math.round(position);
      const slot = beatIndex % 4;
      beatAccentTotals[slot] += (onset[frame] || 0) * 0.72 + (rms[frame] || 0) * 0.28;
      beatAccentCounts[slot] += 1;
      beatIndex += 1;
    }
    const downbeatSlot = beatAccentTotals
      .map((total, index) => total / Math.max(1, beatAccentCounts[index]))
      .reduce((best, value, index, values) => value > values[best] ? index : best, 0);
    const phaseSeconds = (phase * hop) / sampleRate;
    const barPhaseSeconds = (phaseSeconds + downbeatSlot * beatDuration) % barDuration;
    const barCount = Math.max(1, Math.ceil((buffer.duration - barPhaseSeconds) / barDuration));
    const barEnergy = new Float32Array(barCount);

    for (let bar = 0; bar < barCount; bar += 1) {
      const startSeconds = barPhaseSeconds + bar * barDuration;
      const endSeconds = Math.min(buffer.duration, startSeconds + barDuration);
      const startFrame = Math.max(0, Math.floor((startSeconds * sampleRate) / hop));
      const endFrame = Math.min(frameCount, Math.ceil((endSeconds * sampleRate) / hop));
      let total = 0;
      for (let i = startFrame; i < endFrame; i += 1) total += rms[i];
      barEnergy[bar] = total / Math.max(1, endFrame - startFrame);
    }

    const energyMax = Math.max(...barEnergy, 1e-6);
    for (let i = 0; i < barEnergy.length; i += 1) barEnergy[i] /= energyMax;

    progress(38, `检测到约 ${bestBpm} BPM，正在定位自然小节…`);
    return {
      bpm: bestBpm,
      beatDuration,
      barDuration,
      barCount,
      barEnergy,
      phaseSeconds,
      barPhaseSeconds,
      downbeatSlot,
      phraseBars: 4
    };
  }

  function average(values, start, count) {
    let total = 0;
    for (let i = 0; i < count; i += 1) total += values[start + i] || 0;
    return total / Math.max(1, count);
  }

  function chooseMiddleStart(analysis, middleBars, introBars, outroBars, strategy) {
    const { barCount, barEnergy } = analysis;
    const minStart = Math.max(introBars + 1, 1);
    const maxStart = Math.max(minStart, barCount - outroBars - middleBars - 1);
    const outroStart = Math.max(0, barCount - outroBars);
    let bestStart = minStart;
    let bestScore = -Infinity;

    for (let start = minStart; start <= maxStart; start += 1) {
      const energy = average(barEnergy, start, middleBars);
      const center = start + middleBars / 2;
      const desiredCenter = barCount * 0.62;
      const positionScore = 1 - Math.min(1, Math.abs(center - desiredCenter) / Math.max(1, barCount * 0.5));
      const inEnergy = Math.abs((barEnergy[introBars - 1] || 0) - (barEnergy[start] || 0));
      const outEnergy = Math.abs((barEnergy[start + middleBars - 1] || 0) - (barEnergy[outroStart] || 0));
      const smoothness = 1 - Math.min(1, (inEnergy + outEnergy) / 2);

      let score;
      if (strategy === 'energy') score = energy * 0.82 + positionScore * 0.18;
      else if (strategy === 'smooth') score = smoothness * 0.72 + energy * 0.2 + positionScore * 0.08;
      else score = energy * 0.44 + positionScore * 0.34 + smoothness * 0.22;

      if (score > bestScore) {
        bestScore = score;
        bestStart = start;
      }
    }
    return bestStart;
  }

  function buildPlan(buffer, targetSeconds, analysis, strategy) {
    const { barDuration, barCount, barEnergy } = analysis;
    const targetBars = Math.max(3, Math.min(barCount - 1, Math.round(targetSeconds / barDuration)));
    let introBars = targetBars < 9 ? 1 : Math.max(2, Math.round(targetBars * 0.15));
    let outroBars = targetBars < 9 ? 1 : Math.max(2, Math.round(targetBars * 0.14));
    if (introBars + outroBars >= targetBars) {
      introBars = 1;
      outroBars = 1;
    }
    const middleBars = Math.max(1, targetBars - introBars - outroBars);
    const middleStart = chooseMiddleStart(analysis, middleBars, introBars, outroBars, strategy);
    const outroStart = Math.max(0, barCount - outroBars);

    const rawSegments = [
      { start: 0, end: Math.min(buffer.duration, introBars * barDuration), role: '开头' },
      { start: middleStart * barDuration, end: Math.min(buffer.duration, (middleStart + middleBars) * barDuration), role: '核心段落' },
      { start: outroStart * barDuration, end: buffer.duration, role: '原曲结尾' }
    ];

    const segments = [];
    for (const segment of rawSegments) {
      if (segment.end - segment.start < 0.2) continue;
      const previous = segments[segments.length - 1];
      if (previous && segment.start <= previous.end + 0.03) {
        previous.end = Math.max(previous.end, segment.end);
        previous.role += `＋${segment.role}`;
      } else {
        segments.push({ ...segment });
      }
    }

    const selectedEnergy = average(barEnergy, middleStart, middleBars);
    return {
      strategy,
      name: STRATEGIES[strategy].name,
      description: STRATEGIES[strategy].description,
      targetSeconds,
      segments,
      cutCount: Math.max(0, segments.length - 1),
      selectedEnergy,
      targetBars,
      crossfadeSeconds: Math.max(0.18, Math.min(0.75, analysis.beatDuration)),
      cutMode: '小节对齐 · 整拍交叉衔接'
    };
  }

  function normalizeAllowedRanges(buffer, allowedRanges) {
    const ranges = (allowedRanges || [])
      .map(range => ({
        start: Math.max(0, Math.min(buffer.duration, Number(range.start) || 0)),
        end: Math.max(0, Math.min(buffer.duration, Number(range.end) || 0)),
        role: range.label || '所选段落',
        type: range.type || 'verse'
      }))
      .filter(range => range.end - range.start >= 0.2)
      .sort((a, b) => a.start - b.start);
    return ranges.filter((range, index) => index === 0 || range.end > ranges[index - 1].end + 0.02);
  }

  function rangeEnergy(analysis, start, end) {
    const origin = analysis.barPhaseSeconds || 0;
    const firstBar = Math.max(0, Math.floor((start - origin) / analysis.barDuration));
    const lastBar = Math.min(analysis.barCount, Math.ceil((end - origin) / analysis.barDuration));
    return average(analysis.barEnergy, firstBar, Math.max(1, lastBar - firstBar));
  }

  function chooseCandidateRanges(ranges, targetSeconds, analysis, strategy) {
    if (ranges.length <= 3) return ranges;
    const maxPreferred = targetSeconds < 45 ? 3 : targetSeconds < 100 ? 4 : 5;
    const chosen = new Set([0, ranges.length - 1]);
    const candidates = ranges.slice(1, -1).map((range, offset) => {
      const index = offset + 1;
      const energy = rangeEnergy(analysis, range.start, range.end);
      const center = (range.start + range.end) * 0.5;
      const normalizedPosition = center / Math.max(1, ranges[ranges.length - 1].end);
      let score = energy;
      if (strategy === 'balanced') score = 1 - Math.abs(normalizedPosition - 0.58) * 0.55 + energy * 0.28;
      if (strategy === 'smooth') {
        const firstEnergy = rangeEnergy(analysis, ranges[0].start, ranges[0].end);
        const lastEnergy = rangeEnergy(analysis, ranges[ranges.length - 1].start, ranges[ranges.length - 1].end);
        score = 1 - (Math.abs(energy - firstEnergy) + Math.abs(energy - lastEnergy)) * 0.45 + (1 - normalizedPosition) * 0.05;
      }
      return { index, score };
    }).sort((a, b) => b.score - a.score);

    let capacity = [...chosen].reduce((sum, index) => sum + ranges[index].end - ranges[index].start, 0);
    const preferredCapacity = targetSeconds + analysis.beatDuration * Math.max(0, maxPreferred - 1);
    for (const candidate of candidates) {
      if (chosen.size >= maxPreferred && capacity >= preferredCapacity) break;
      chosen.add(candidate.index);
      capacity += ranges[candidate.index].end - ranges[candidate.index].start;
    }
    return [...chosen].sort((a, b) => a - b).map(index => ranges[index]);
  }

  function allocateDurations(ranges, requestedDuration, analysis, strategy) {
    const allocations = new Array(ranges.length).fill(0);
    const weights = ranges.map((range, index) => {
      const duration = range.end - range.start;
      const energy = rangeEnergy(analysis, range.start, range.end);
      if (strategy === 'energy') return duration * (0.35 + energy * 1.25);
      if (strategy === 'smooth') return duration * (1 + (ranges.length - index) * 0.025);
      return duration;
    });
    let remaining = requestedDuration;
    let available = ranges.map((_, index) => index);

    for (let pass = 0; pass < ranges.length + 2 && remaining > 0.01 && available.length; pass += 1) {
      const weightTotal = available.reduce((sum, index) => sum + weights[index], 0) || available.length;
      const next = [];
      let used = 0;
      available.forEach(index => {
        const capacity = ranges[index].end - ranges[index].start - allocations[index];
        const share = remaining * ((weights[index] || 1) / weightTotal);
        const added = Math.min(capacity, share);
        allocations[index] += added;
        used += added;
        if (capacity - added > 0.01) next.push(index);
      });
      if (used < 0.001) break;
      remaining -= used;
      available = next;
    }
    return allocations;
  }

  function chooseWindowInRange(range, duration, analysis, strategy, rangeIndex) {
    const barDuration = analysis.barDuration;
    const origin = analysis.barPhaseSeconds || 0;
    const alignUp = time => origin + Math.ceil((time - origin - 0.01) / barDuration) * barDuration;
    const alignDown = time => origin + Math.floor((time - origin + 0.01) / barDuration) * barDuration;
    const alignNearest = time => origin + Math.round((time - origin) / barDuration) * barDuration;
    const alignedStart = range.start < origin ? range.start : alignUp(range.start);
    const alignedEnd = alignDown(range.end);
    const gridStart = alignedEnd - alignedStart >= barDuration ? alignedStart : range.start;
    const gridEnd = alignedEnd - alignedStart >= barDuration ? alignedEnd : range.end;
    const capacity = gridEnd - gridStart;
    const barCount = Math.max(1, Math.min(Math.floor(capacity / barDuration), Math.round(duration / barDuration)));
    const alignedDuration = Math.min(capacity, barCount * barDuration);
    if (range.start < origin && origin > 0.01) {
      const musicalEnd = Math.min(gridEnd, Math.max(origin, alignNearest(range.start + duration)));
      return { start: range.start, end: musicalEnd };
    }
    if (alignedDuration >= capacity - 0.02) return { start: gridStart, end: gridEnd };
    if (strategy === 'balanced') {
      const rawStart = gridStart + (capacity - alignedDuration) * 0.5;
      const start = alignNearest(rawStart);
      return { start, end: Math.min(gridEnd, start + alignedDuration) };
    }
    if (strategy === 'smooth') {
      const start = rangeIndex % 2 === 0 ? gridStart : gridEnd - alignedDuration;
      return { start, end: start + alignedDuration };
    }

    const step = barDuration;
    let bestStart = gridStart;
    let bestEnergy = -1;
    for (let start = gridStart; start <= gridEnd - alignedDuration + 0.01; start += step) {
      const energy = rangeEnergy(analysis, start, start + alignedDuration);
      if (energy > bestEnergy) {
        bestEnergy = energy;
        bestStart = start;
      }
    }
    return { start: bestStart, end: Math.min(gridEnd, bestStart + alignedDuration) };
  }

  function buildConstrainedPlan(buffer, targetSeconds, analysis, strategy, allowedRanges) {
    const ranges = normalizeAllowedRanges(buffer, allowedRanges);
    if (!ranges.length) throw new Error('请至少选择一个参与重编排的歌曲段落。');
    const availableDuration = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
    if (availableDuration + 0.05 < targetSeconds) {
      throw new Error(`已选段落共 ${Math.round(availableDuration)} 秒，短于 ${Math.round(targetSeconds)} 秒的目标时长。请再选择一些段落或缩短目标时长。`);
    }

    const candidateRanges = chooseCandidateRanges(ranges, targetSeconds, analysis, strategy);
    const expectedCuts = Math.max(0, candidateRanges.length - 1);
    const crossfadeSeconds = Math.max(0.18, Math.min(0.75, analysis.beatDuration));
    const requestedDuration = Math.min(availableDuration, targetSeconds + expectedCuts * crossfadeSeconds);
    const allocations = allocateDurations(candidateRanges, requestedDuration, analysis, strategy);
    const segments = candidateRanges
      .map((range, index) => {
        if (allocations[index] < 0.2) return null;
        const window = chooseWindowInRange(range, allocations[index], analysis, strategy, index);
        return { ...window, role: range.role };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);

    const selectedEnergy = segments.reduce((sum, segment) => sum + rangeEnergy(analysis, segment.start, segment.end), 0) / Math.max(1, segments.length);
    return {
      strategy,
      name: '候选方案',
      description: '仅使用用户选中的原曲段落。',
      targetSeconds,
      segments,
      cutCount: Math.max(0, segments.length - 1),
      selectedEnergy,
      targetBars: Math.max(1, Math.round(targetSeconds / analysis.barDuration)),
      crossfadeSeconds,
      cutMode: '小节对齐 · 整拍交叉衔接',
      transitionGainMatching: true
    };
  }

  function findQuietCrossing(data, frame, radius) {
    const from = Math.max(1, frame - radius);
    const to = Math.min(data.length - 2, frame + radius);
    let bestFrame = Math.max(from, Math.min(to, frame));
    let bestScore = Infinity;
    for (let index = from; index <= to; index += 1) {
      const crossing = (data[index - 1] <= 0 && data[index] >= 0) || (data[index - 1] >= 0 && data[index] <= 0);
      const distancePenalty = Math.abs(index - frame) / Math.max(1, radius) * 0.08;
      const score = Math.abs(data[index]) + distancePenalty + (crossing ? 0 : 0.25);
      if (score < bestScore) {
        bestScore = score;
        bestFrame = index;
      }
    }
    return bestFrame;
  }

  function copySegment(buffer, segment) {
    const sampleRate = buffer.sampleRate;
    const guide = buffer.getChannelData(0);
    const radius = Math.max(1, Math.round(sampleRate * 0.008));
    const rawStart = Math.max(0, Math.floor(segment.start * sampleRate));
    const rawEnd = Math.min(buffer.length, Math.ceil(segment.end * sampleRate));
    const startFrame = rawStart === 0 ? 0 : findQuietCrossing(guide, rawStart, radius);
    const endFrame = rawEnd === buffer.length ? buffer.length : findQuietCrossing(guide, rawEnd, radius);
    const length = Math.max(0, endFrame - startFrame);
    const count = Math.min(buffer.numberOfChannels, 2);
    const channels = [];
    for (let c = 0; c < count; c += 1) channels.push(buffer.getChannelData(c).slice(startFrame, endFrame));
    return { channels, length };
  }

  function stitchSegments(buffer, plan) {
    const pieces = plan.segments.map(segment => copySegment(buffer, segment));
    const crossfadeFrames = Math.round(buffer.sampleRate * (plan.crossfadeSeconds || 0.12));
    let totalLength = pieces.reduce((sum, piece) => sum + piece.length, 0);
    for (let i = 1; i < pieces.length; i += 1) totalLength -= Math.min(crossfadeFrames, pieces[i - 1].length, pieces[i].length);
    const channelCount = Math.min(buffer.numberOfChannels, 2);
    const output = Array.from({ length: channelCount }, () => new Float32Array(Math.max(1, totalLength)));
    let cursor = 0;

    pieces.forEach((piece, pieceIndex) => {
      if (pieceIndex === 0) {
        for (let c = 0; c < channelCount; c += 1) output[c].set(piece.channels[c], 0);
        cursor = piece.length;
        return;
      }

      const overlap = Math.min(crossfadeFrames, Math.floor(cursor / 3), Math.floor(piece.length / 3));
      for (let c = 0; c < channelCount; c += 1) {
        const source = piece.channels[c];
        let tailPower = 0;
        let headPower = 0;
        for (let i = 0; i < overlap; i += 1) {
          tailPower += output[c][cursor - overlap + i] ** 2;
          headPower += source[i] ** 2;
        }
        const tailRms = Math.sqrt(tailPower / Math.max(1, overlap));
        const headRms = Math.sqrt(headPower / Math.max(1, overlap));
        const matchGain = Math.max(0.68, Math.min(1.38, tailRms / Math.max(0.0001, headRms)));
        const recoveryFrames = Math.min(source.length, Math.max(overlap, crossfadeFrames * 3));
        for (let i = 0; i < recoveryFrames; i += 1) {
          const recovery = i / Math.max(1, recoveryFrames - 1);
          source[i] *= matchGain + (1 - matchGain) * recovery;
        }
        for (let i = 0; i < overlap; i += 1) {
          const t = i / Math.max(1, overlap - 1);
          const fadeOut = Math.cos(t * Math.PI * 0.5);
          const fadeIn = Math.sin(t * Math.PI * 0.5);
          output[c][cursor - overlap + i] = output[c][cursor - overlap + i] * fadeOut + source[i] * fadeIn;
        }
        output[c].set(source.subarray(overlap), cursor);
      }
      cursor += piece.length - overlap;
    });

    return output.map(channel => channel.subarray(0, cursor));
  }

  function resampleToExactLength(channels, targetLength) {
    const sourceLength = channels[0].length;
    if (sourceLength === targetLength) return channels;
    const ratio = (sourceLength - 1) / Math.max(1, targetLength - 1);
    return channels.map(source => {
      const output = new Float32Array(targetLength);
      for (let i = 0; i < targetLength; i += 1) {
        const position = i * ratio;
        const left = Math.floor(position);
        const right = Math.min(sourceLength - 1, left + 1);
        const fraction = position - left;
        output[i] = source[left] * (1 - fraction) + source[right] * fraction;
      }
      return output;
    });
  }

  function applyMasterFade(channels, sampleRate) {
    const fadeFrames = Math.min(Math.round(sampleRate * 0.32), Math.floor(channels[0].length / 8));
    for (const channel of channels) {
      for (let i = 0; i < fadeFrames; i += 1) {
        const inGain = Math.sin((i / fadeFrames) * Math.PI * 0.5);
        const outGain = Math.sin(((fadeFrames - i) / fadeFrames) * Math.PI * 0.5);
        channel[i] *= inGain;
        channel[channel.length - 1 - i] *= outGain;
      }
    }
  }

  function normalize(channels) {
    let peak = 0;
    for (const channel of channels) for (let i = 0; i < channel.length; i += 1) peak = Math.max(peak, Math.abs(channel[i]));
    if (peak <= 0 || peak <= 0.96) return;
    const gain = 0.96 / peak;
    for (const channel of channels) for (let i = 0; i < channel.length; i += 1) channel[i] *= gain;
  }

  function encodeWav(channels, sampleRate) {
    const channelCount = channels.length;
    const sampleCount = channels[0].length;
    const bytesPerSample = 2;
    const dataSize = sampleCount * channelCount * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeText = (offset, text) => {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channelCount, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
    view.setUint16(32, channelCount * bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, dataSize, true);
    let offset = 44;
    for (let i = 0; i < sampleCount; i += 1) {
      for (let c = 0; c < channelCount; c += 1) {
        const sample = Math.max(-1, Math.min(1, channels[c][i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }
    return new Uint8Array(buffer);
  }

  async function renderPlan(buffer, plan, progress = () => {}) {
    let channels = stitchSegments(buffer, plan);
    progress(62, '正在构建候选方案…');
    const targetLength = Math.max(1, Math.round(plan.targetSeconds * buffer.sampleRate));
    channels = resampleToExactLength(channels, targetLength);
    applyMasterFade(channels, buffer.sampleRate);
    normalize(channels);
    const wavBytes = encodeWav(channels, buffer.sampleRate);
    return {
      ...plan,
      bpm: null,
      wavBytes,
      blob: new Blob([wavBytes], { type: 'audio/wav' })
    };
  }

  async function process(buffer, targetSeconds, requestedStrategy, progress = () => {}, precomputedAnalysis = null, allowedRanges = null) {
    if (targetSeconds < 8) throw new Error('目标时长至少需要 8 秒。');
    if (targetSeconds >= buffer.duration - 1) throw new Error('目标时长需要短于原曲至少 1 秒。');
    progress(3, '读取音频波形…');
    await new Promise(resolve => setTimeout(resolve, 30));
    const analysis = precomputedAnalysis || analyzeRhythm(buffer, progress);
    const strategies = requestedStrategy === 'all' ? ['energy', 'balanced', 'smooth'] : [requestedStrategy];
    const results = [];
    for (let i = 0; i < strategies.length; i += 1) {
      const strategy = strategies[i];
      const plan = allowedRanges
        ? buildConstrainedPlan(buffer, targetSeconds, analysis, strategy, allowedRanges)
        : buildPlan(buffer, targetSeconds, analysis, strategy);
      const base = 46 + (i / strategies.length) * 48;
      progress(base, `正在生成方案 ${String.fromCharCode(65 + i)}…`);
      const result = await renderPlan(buffer, plan, progress);
      result.bpm = analysis.bpm;
      result.barDuration = analysis.barDuration;
      results.push(result);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    progress(100, '重编排完成');
    return { analysis, results };
  }

  window.VistaAudio = { decodeFile, analyze: analyzeRhythm, process, STRATEGIES };
})();
