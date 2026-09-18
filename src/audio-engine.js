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

  /* ------------------------------------------------------------------ *
   * 频谱特征（色度 chroma + 谱质心）
   *
   * 段落识别不能只看"响不响"。一首歌里响的段落可能有很多种：副歌、器乐间奏、
   * 预副歌的爬升、尾奏的全奏。真正能把"主歌 / 副歌"分开的是**和声内容的重复**：
   * 副歌会以几乎相同的和声与配器再次出现，主歌也是。
   * 所以这里算 12 维色度向量，后面用自相似矩阵找"重复出现的段落"。
   * ------------------------------------------------------------------ */

  const FFT_SIZE = 2048;
  const FFT_HOP = 1024;
  const SPECTRAL_LOW_HZ = 55;
  const CHROMA_HIGH_HZ = 2000;
  const SPECTRAL_HIGH_HZ = 5000;

  function fftInPlace(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i += 1) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1;
        let ci = 0;
        for (let k = 0; k < half; k += 1) {
          const ur = re[i + k];
          const ui = im[i + k];
          const xr = re[i + k + half];
          const xi = im[i + k + half];
          const vr = xr * cr - xi * ci;
          const vi = xr * ci + xi * cr;
          re[i + k] = ur + vr;
          im[i + k] = ui + vi;
          re[i + k + half] = ur - vr;
          im[i + k + half] = ui - vi;
          const nr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = nr;
        }
      }
    }
  }

  // 盒式低通 + 抽取。色度只关心 55–2000 Hz，降到约 11 kHz 能让 FFT 次数少 4 倍。
  function decimate(mono, sampleRate) {
    let factor = 1;
    if (sampleRate >= 32000) factor = 4;
    else if (sampleRate >= 16000) factor = 2;
    if (factor === 1) return { signal: mono, rate: sampleRate, factor };
    const length = Math.floor(mono.length / factor);
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      let sum = 0;
      const base = i * factor;
      for (let k = 0; k < factor; k += 1) sum += mono[base + k] || 0;
      out[i] = sum / factor;
    }
    return { signal: out, rate: sampleRate / factor, factor };
  }

  async   function spectralFrames(mono, sampleRate, progress = () => {}) {
    const { signal, rate } = decimate(mono, sampleRate);
    const frameCount = Math.max(1, Math.floor((signal.length - FFT_SIZE) / FFT_HOP) + 1);
    const chromaFrames = new Float32Array(frameCount * 12);
    const centroids = new Float32Array(frameCount);
    const spectralFlux = new Float32Array(frameCount);
    const vocalActivity = new Float32Array(frameCount);
    const window = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i += 1) {
      window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
    }
    const re = new Float32Array(FFT_SIZE);
    const im = new Float32Array(FFT_SIZE);
    const binHz = rate / FFT_SIZE;
    const lowBin = Math.max(1, Math.floor(SPECTRAL_LOW_HZ / binHz));
    const highBin = Math.min(FFT_SIZE / 2 - 1, Math.ceil(SPECTRAL_HIGH_HZ / binHz));
    const chromaHighBin = Math.min(highBin, Math.ceil(CHROMA_HIGH_HZ / binHz));
    const vocalLowBin = Math.max(lowBin, Math.floor(160 / binHz));
    const vocalHighBin = Math.min(highBin, Math.ceil(3500 / binHz));
    const magnitudes = new Float32Array(highBin + 2);
    const previousMagnitudes = new Float32Array(highBin + 2);

    for (let frame = 0; frame < frameCount; frame += 1) {
      const from = frame * FFT_HOP;
      for (let i = 0; i < FFT_SIZE; i += 1) {
        re[i] = (signal[from + i] || 0) * window[i];
        im[i] = 0;
      }
      fftInPlace(re, im);

      let sum = 0;
      let weighted = 0;
      const base = frame * 12;
      for (let k = lowBin; k <= highBin; k += 1) {
        const magnitude = Math.log1p(Math.sqrt(re[k] * re[k] + im[k] * im[k]));
        magnitudes[k] = magnitude;
        if (magnitude <= 0) continue;
        const frequency = k * binHz;
        sum += magnitude;
        weighted += frequency * magnitude;
      }
      let positiveFlux = 0;
      let vocalBandEnergy = 0;
      for (let k = lowBin; k <= highBin; k += 1) {
        positiveFlux += Math.max(0, magnitudes[k] - previousMagnitudes[k]);
        previousMagnitudes[k] = magnitudes[k];
        if (k >= vocalLowBin && k <= vocalHighBin) vocalBandEnergy += magnitudes[k];
      }
      spectralFlux[frame] = positiveFlux / Math.max(1e-6, sum);

      // 色度只累计局部谱峰，避免宽带鼓声把十二个音级一起抬高。
      let vocalPeakEnergy = 0;
      for (let k = lowBin + 1; k < chromaHighBin; k += 1) {
        const magnitude = magnitudes[k];
        if (magnitude <= magnitudes[k - 1] || magnitude < magnitudes[k + 1]) continue;
        const frequency = k * binHz;
        const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
        const pitchClass = ((midi % 12) + 12) % 12;
        chromaFrames[base + pitchClass] += magnitude * magnitude;
        if (k >= vocalLowBin && k <= vocalHighBin) vocalPeakEnergy += magnitude;
      }
      const harmonicRatio = vocalPeakEnergy / Math.max(1e-6, vocalBandEnergy);
      vocalActivity[frame] = vocalBandEnergy * (0.35 + Math.min(1, harmonicRatio * 5) * 0.65);
      let norm = 0;
      for (let c = 0; c < 12; c += 1) norm += chromaFrames[base + c] * chromaFrames[base + c];
      norm = Math.sqrt(norm);
      if (norm > 1e-9) {
        for (let c = 0; c < 12; c += 1) chromaFrames[base + c] /= norm;
      }
      centroids[frame] = sum > 1e-9 ? weighted / sum : 0;

      if (frame % 200 === 0) {
        progress(38 + (frame / frameCount) * 16, '分析和声、人声活动与音色，寻找歌词气口…');
        await yieldToUi();
      }
    }
    // 帧步长是在"抽取之后"的信号上计的，所以要用抽取后的采样率换算，
    // 不能乘回原采样率——否则每帧被低估 16 倍，除开头几小节外全部取不到数据。
    robustScale(spectralFlux);
    robustScale(vocalActivity);
    return { chromaFrames, centroids, spectralFlux, vocalActivity, frameCount, secondsPerFrame: FFT_HOP / rate };
  }

  // 分析过程是纯计算，中途要让出主线程，否则界面会整体卡住、进度文案不动
  const yieldToUi = () => new Promise(resolve => setTimeout(resolve, 0));

  async function analyzeRhythm(buffer, progress = () => {}) {
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
      if (frame % 1200 === 0) {
        progress(8 + (frame / frameCount) * 18, '扫描响度与瞬态变化…');
        await yieldToUi();
      }
    }

    // 先提取频谱通量。单看 RMS 会把持续变响误认成鼓点，也看不见响度不变的音色瞬态。
    const spectral = await spectralFrames(mono, sampleRate, progress);
    const rmsFlux = new Float32Array(frameCount);
    for (let i = 2; i < frameCount; i += 1) {
      const current = Math.log1p(rms[i] * 1000);
      const previous = (Math.log1p(rms[i - 1] * 1000) + Math.log1p(rms[i - 2] * 1000)) * 0.5;
      rmsFlux[i] = Math.max(0, current - previous);
    }
    robustScale(rmsFlux);

    const onset = new Float32Array(frameCount);
    const onsetRaw = new Float32Array(frameCount);
    const rmsSecondsPerFrame = hop / sampleRate;
    for (let i = 0; i < frameCount; i += 1) {
      const spectralPosition = (i * rmsSecondsPerFrame) / spectral.secondsPerFrame;
      const left = Math.min(spectral.frameCount - 1, Math.max(0, Math.floor(spectralPosition)));
      const right = Math.min(spectral.frameCount - 1, left + 1);
      const fraction = spectralPosition - left;
      const flux = spectral.spectralFlux[left] * (1 - fraction) + spectral.spectralFlux[right] * fraction;
      // RMS 差分保留原采样率下约 20–25 ms 的节拍精度；频谱通量负责补足音色突变。
      onsetRaw[i] = rmsFlux[i] * 0.68 + flux * 0.32;
    }
    const adaptiveWindow = Math.max(4, Math.round(0.35 / rmsSecondsPerFrame));
    for (let i = 0; i < frameCount; i += 1) {
      let local = 0;
      let count = 0;
      for (let k = Math.max(0, i - adaptiveWindow); k < i; k += 1) {
        local += onsetRaw[k];
        count += 1;
      }
      const value = Math.max(0, onsetRaw[i] - (local / Math.max(1, count)) * 0.48);
      const isPeak = value >= (onsetRaw[i - 1] || 0) && value >= (onsetRaw[i + 1] || 0);
      onset[i] = value * (isPeak ? 1 : 0.35);
    }
    robustScale(onset);

    const framesPerSecond = sampleRate / hop;
    const onsetPeaks = [];
    const peakFloor = percentile([...onset], 0.78);
    const peakSpacing = Math.max(2, Math.round(framesPerSecond * 0.18));
    for (let i = 1; i < frameCount - 1; i += 1) {
      if (onset[i] < peakFloor || onset[i] < onset[i - 1] || onset[i] < onset[i + 1]) continue;
      const previousPeak = onsetPeaks[onsetPeaks.length - 1];
      if (previousPeak !== undefined && i - previousPeak < peakSpacing) {
        if (onset[i] > onset[previousPeak]) onsetPeaks[onsetPeaks.length - 1] = i;
      } else {
        onsetPeaks.push(i);
      }
    }
    const correlationAt = lagValue => {
      const lag = Math.max(1, lagValue);
      let dot = 0;
      let leftPower = 0;
      let rightPower = 0;
      for (let i = Math.ceil(lag); i < frameCount; i += 1) {
        const shifted = i - lag;
        const left = Math.floor(shifted);
        const fraction = shifted - left;
        const delayed = onset[left] * (1 - fraction) + (onset[left + 1] || 0) * fraction;
        dot += onset[i] * delayed;
        leftPower += onset[i] * onset[i];
        rightPower += delayed * delayed;
      }
      return dot / Math.max(1e-9, Math.sqrt(leftPower * rightPower));
    };
    const tempoCandidates = [];
    for (let bpm = 60; bpm <= 200; bpm += 1) {
      const lag = (60 / bpm) * framesPerSecond;
      const autocorrelation = correlationAt(lag) * 0.62
        + correlationAt(lag * 2) * 0.26
        + correlationAt(lag * 4) * 0.12;
      let intervalSupport = 0;
      let intervalWeight = 0;
      const beatSeconds = 60 / bpm;
      for (let i = 1; i < onsetPeaks.length; i += 1) {
        const interval = (onsetPeaks[i] - onsetPeaks[i - 1]) / framesPerSecond;
        const beats = Math.max(1, Math.min(4, Math.round(interval / beatSeconds)));
        const error = Math.abs(interval / beatSeconds - beats);
        const weight = Math.sqrt((onset[onsetPeaks[i]] || 0) * (onset[onsetPeaks[i - 1]] || 0)) / beats;
        intervalSupport += Math.exp(-0.5 * (error / 0.045) ** 2) * weight;
        intervalWeight += weight;
      }
      intervalSupport /= Math.max(1e-9, intervalWeight);
      const score = autocorrelation * 0.72 + intervalSupport * 0.28;
      // 只给常见流行音乐速度一个很轻的先验，不能再用固定 118 BPM 把结果拉偏。
      const prior = bpm >= 80 && bpm <= 160 ? 1 : 0.965;
      tempoCandidates.push({ bpm, score: score * prior });
      if (bpm % 30 === 0) await yieldToUi();
    }
    tempoCandidates.sort((a, b) => b.score - a.score);
    let winner = tempoCandidates[0] || { bpm: 120, score: 0 };
    if (winner.bpm > 160) {
      const half = tempoCandidates.find(item => item.bpm === Math.round(winner.bpm / 2));
      if (half && half.score >= winner.score * 0.9) winner = half;
    } else if (winner.bpm < 80) {
      const double = tempoCandidates.find(item => item.bpm === winner.bpm * 2);
      if (double && double.score > winner.score * 1.04) winner = double;
    }
    const bestBpm = winner.bpm;
    const scoreDistribution = tempoCandidates.map(item => item.score);
    const tempoConfidence = Math.max(0, Math.min(1,
      (winner.score - median(scoreDistribution)) / Math.max(0.05, mad(scoreDistribution) * 4)
    ));

    const beatFrames = (60 / bestBpm) * framesPerSecond;
    const phaseLimit = Math.max(1, Math.round(beatFrames));
    let phase = 0;
    let phaseScore = -1;
    for (let offset = 0; offset < phaseLimit; offset += 1) {
      let score = 0;
      for (let p = offset; p < frameCount; p += beatFrames) {
        const frame = Math.round(p);
        score += (onset[frame] || 0) + (onset[frame - 1] || 0) * 0.35 + (onset[frame + 1] || 0) * 0.35;
      }
      if (score > phaseScore) {
        phaseScore = score;
        phase = offset;
      }
    }

    const beatDuration = 60 / bestBpm;
    const beatAccents = [];
    for (let position = phase; position < frameCount; position += beatFrames) {
      const frame = Math.round(position);
      beatAccents.push((onset[frame] || 0) * 0.78 + (rms[frame] || 0) * 0.22);
    }
    const accentPeriodicity = meter => {
      let dot = 0;
      let powerA = 0;
      let powerB = 0;
      for (let i = meter; i < beatAccents.length; i += 1) {
        dot += beatAccents[i] * beatAccents[i - meter];
        powerA += beatAccents[i] ** 2;
        powerB += beatAccents[i - meter] ** 2;
      }
      return dot / Math.max(1e-9, Math.sqrt(powerA * powerB));
    };
    const meter3Score = accentPeriodicity(3);
    const meter4Score = accentPeriodicity(4);
    // 只有三拍周期明显更强时才判为 3/4；模糊材料继续按最常见的 4/4 处理。
    const beatsPerBar = meter3Score > meter4Score * 1.12 ? 3 : 4;
    const barDuration = beatDuration * beatsPerBar;
    const metricalAccent = beatsPerBar === 3 ? [1, 0.45, 0.55] : [1, 0.46, 0.72, 0.42];
    const downbeatScores = new Array(beatsPerBar).fill(0);
    for (let candidate = 0; candidate < beatsPerBar; candidate += 1) {
      for (let i = 0; i < beatAccents.length; i += 1) {
        downbeatScores[candidate] += beatAccents[i] * metricalAccent[(i - candidate + beatsPerBar) % beatsPerBar];
      }
    }
    const downbeatSlot = downbeatScores.reduce((best, value, index, values) => value > values[best] ? index : best, 0);
    const phaseSeconds = (phase * hop) / sampleRate;
    const barPhaseSeconds = (phaseSeconds + downbeatSlot * beatDuration) % barDuration;
    const barCount = Math.max(1, Math.ceil((buffer.duration - barPhaseSeconds) / barDuration));
    const barEnergy = new Float32Array(barCount);
    const barOnset = new Float32Array(barCount);

    for (let bar = 0; bar < barCount; bar += 1) {
      const startSeconds = barPhaseSeconds + bar * barDuration;
      const endSeconds = Math.min(buffer.duration, startSeconds + barDuration);
      const startFrame = Math.max(0, Math.floor((startSeconds * sampleRate) / hop));
      const endFrame = Math.min(frameCount, Math.ceil((endSeconds * sampleRate) / hop));
      let total = 0;
      let drumHits = 0;
      for (let i = startFrame; i < endFrame; i += 1) {
        total += rms[i];
        drumHits += onset[i] || 0;
      }
      const span = Math.max(1, endFrame - startFrame);
      barEnergy[bar] = total / span;
      barOnset[bar] = drumHits / span;
    }

    const energyMax = Math.max(...barEnergy, 1e-6);
    for (let i = 0; i < barEnergy.length; i += 1) barEnergy[i] /= energyMax;
    robustScale(barEnergy);
    const barOnsetMax = Math.max(...barOnset, 1e-6);
    for (let i = 0; i < barOnset.length; i += 1) barOnset[i] /= barOnsetMax;
    robustScale(barOnset);

    progress(38, `检测到约 ${bestBpm} BPM，正在定位自然小节…`);

    const barChroma = new Float32Array(barCount * 12);
    const barCentroid = new Float32Array(barCount);
    for (let bar = 0; bar < barCount; bar += 1) {
      const startSeconds = barPhaseSeconds + bar * barDuration;
      const endSeconds = Math.min(buffer.duration, startSeconds + barDuration);
      const from = Math.min(spectral.frameCount - 1, Math.max(0, Math.floor(startSeconds / spectral.secondsPerFrame)));
      const to = Math.min(spectral.frameCount, Math.max(from + 1, Math.ceil(endSeconds / spectral.secondsPerFrame)));
      const target = bar * 12;
      let centroidSum = 0;
      for (let f = from; f < to; f += 1) {
        const base = f * 12;
        for (let c = 0; c < 12; c += 1) barChroma[target + c] += spectral.chromaFrames[base + c];
        centroidSum += spectral.centroids[f];
      }
      const frames = Math.max(1, to - from);
      let norm = 0;
      for (let c = 0; c < 12; c += 1) norm += barChroma[target + c] * barChroma[target + c];
      norm = Math.sqrt(norm);
      if (norm > 1e-9) {
        for (let c = 0; c < 12; c += 1) barChroma[target + c] /= norm;
      }
      barCentroid[bar] = centroidSum / frames;
    }
    const centroidMax = Math.max(...barCentroid, 1e-6);
    for (let i = 0; i < barCentroid.length; i += 1) barCentroid[i] /= centroidMax;
    robustScale(barCentroid);

    // 流行歌整首通常同一个调，各段色度向量天然都很像。先减掉全曲平均色度，
    // 只留下"这一段和声上有何不同"，重复段落的识别才不会糊成一片。
    const meanChroma = new Float32Array(12);
    for (let bar = 0; bar < barCount; bar += 1) {
      const base = bar * 12;
      for (let c = 0; c < 12; c += 1) meanChroma[c] += barChroma[base + c];
    }
    for (let c = 0; c < 12; c += 1) meanChroma[c] /= Math.max(1, barCount);
    for (let bar = 0; bar < barCount; bar += 1) {
      const base = bar * 12;
      let norm = 0;
      for (let c = 0; c < 12; c += 1) {
        barChroma[base + c] -= meanChroma[c];
        norm += barChroma[base + c] * barChroma[base + c];
      }
      norm = Math.sqrt(norm);
      if (norm > 1e-9) {
        for (let c = 0; c < 12; c += 1) barChroma[base + c] /= norm;
      }
    }

    return {
      bpm: bestBpm,
      beatDuration,
      barDuration,
      barCount,
      barEnergy,
      barOnset,
      barChroma,
      barCentroid,
      phaseSeconds,
      barPhaseSeconds,
      downbeatSlot,
      tempoConfidence,
      tempoAlternatives: tempoCandidates.slice(0, 5).map(item => ({ bpm: item.bpm, score: item.score })),
      beatsPerBar,
      vocalActivity: spectral.vocalActivity,
      vocalSecondsPerFrame: spectral.secondsPerFrame,
      phraseBars: 4
    };
  }

  function average(values, start, count) {
    let total = 0;
    for (let i = 0; i < count; i += 1) total += values[start + i] || 0;
    return total / Math.max(1, count);
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  // 绝对中位差：比标准差抗离群值，用作聚类阈值的尺度更稳
  function mad(values) {
    if (!values.length) return 0;
    const center = median(values);
    return median(values.map(value => Math.abs(value - center)));
  }

  function percentile(values, ratio) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round(ratio * (sorted.length - 1))));
    return sorted[index];
  }

  /* 稳健归一化：用 10%–90% 分位数把数组拉到 0–1，而不是"除以最大值"。
   * 直接除以最大值会被某一个特别响的高潮小节压扁，整首歌的能量差被压缩到很窄的一段，
   * 段落换点在曲线上就看不出起伏了。 */
  function robustScale(values) {
    if (!values.length) return values;
    const sorted = [...values].sort((a, b) => a - b);
    const pick = ratio => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(ratio * (sorted.length - 1))))];
    const low = pick(0.1);
    const span = Math.max(1e-6, pick(0.9) - low);
    for (let i = 0; i < values.length; i += 1) {
      values[i] = Math.max(0, Math.min(1, (values[i] - low) / span));
    }
    return values;
  }

  /* ------------------------------------------------------------------ *
   * 段落结构分析
   *
   * 流行歌的骨架是：前奏 → 主歌 → 预副歌 → 副歌 → 间奏 → 主歌 → 副歌 →（桥段）→ 副歌 → 尾奏
   *
   * 判断"主歌 / 副歌"的依据**不是响度**，而是两条乐理事实：
   *   1. 副歌与主歌都会重复出现，而重复出现的段落和声与配器高度一致；
   *   2. 同一首歌里，副歌的整体能量与鼓点密度通常高于主歌。
   * 所以流程是：先用"和声自相似"找出真正重复的段落并分组，
   * 再在重复组之间比能量，高的一组是副歌，低的一组是主歌。
   * 只出现一次的段落再按位置与走向判断前奏 / 预副歌 / 间奏 / 桥段 / 尾奏。
   * ------------------------------------------------------------------ */

  const SECTION_TYPES = {
    intro: { label: '前奏', color: '#8fa0c6' },
    verse: { label: '主歌', color: '#7e7ce6' },
    prechorus: { label: '预副歌', color: '#dd9a3a' },
    chorus: { label: '副歌', color: '#ef6868' },
    interlude: { label: '间奏', color: '#4f9e93' },
    bridge: { label: '桥段', color: '#4a86cf' },
    outro: { label: '尾奏', color: '#9d9a95' }
  };

  function barVectors(analysis) {
    const { barCount } = analysis;
    const vectors = new Array(barCount);
    for (let bar = 0; bar < barCount; bar += 1) {
      const base = bar * 12;
      const chroma = new Float32Array(12);
      for (let c = 0; c < 12; c += 1) chroma[c] = analysis.barChroma[base + c];
      vectors[bar] = {
        chroma,
        energy: analysis.barEnergy[bar],
        onset: analysis.barOnset[bar],
        centroid: analysis.barCentroid[bar]
      };
    }
    return vectors;
  }

  /* 小节级相似度同时使用和声、力度、瞬态密度和音色。
   * 色度现在只来自局部谱峰，并减去了全曲平均色度，因此可以用于识别重复和弦进行，
   * 不再像旧实现那样被鼓组的宽带能量淹没。 */
  const SIMILARITY_WEIGHTS = { tone: 0.38, power: 0.27, drive: 0.21, colour: 0.14 };

  function frameSimilarity(a, b) {
    let dot = 0;
    for (let i = 0; i < 12; i += 1) dot += a.chroma[i] * b.chroma[i];
    const tone = Math.max(0, Math.min(1, (dot + 1) * 0.5));
    const power = 1 - Math.min(1, Math.abs(a.energy - b.energy) * 2.2);
    const drive = 1 - Math.min(1, Math.abs(a.onset - b.onset) * 2.0);
    const colour = 1 - Math.min(1, Math.abs(a.centroid - b.centroid) * 1.8);
    return tone * SIMILARITY_WEIGHTS.tone
      + power * SIMILARITY_WEIGHTS.power
      + drive * SIMILARITY_WEIGHTS.drive
      + colour * SIMILARITY_WEIGHTS.colour;
  }

  // 多尺度新颖度：同时看 2 小节换句与 4 小节乐句，避免只适合固定八小节结构。
  function noveltyCurve(vectors) {
    const barCount = vectors.length;
    const raw = new Float32Array(barCount);
    for (const span of [2, 4]) {
      for (let i = span; i <= barCount - span; i += 1) {
        let across = 0;
        let within = 0;
        for (let p = 0; p < span; p += 1) {
          for (let q = 0; q < span; q += 1) {
            across += frameSimilarity(vectors[i - span + p], vectors[i + q]);
            within += frameSimilarity(vectors[i - span + p], vectors[i - span + q]);
            within += frameSimilarity(vectors[i + p], vectors[i + q]);
          }
        }
        const crossMean = across / (span * span);
        const withinMean = within / (span * span * 2);
        raw[i] += Math.max(0, withinMean - crossMean) * (span === 4 ? 0.65 : 0.35);
      }
    }
    // 三点滑动平均，压掉"乐句内部换句"这类毛刺，只留真正的段落换点
    const smooth = new Float32Array(barCount);
    for (let i = 1; i < barCount - 1; i += 1) smooth[i] = (raw[i - 1] + raw[i] * 2 + raw[i + 1]) / 4;
    return smooth;
  }

  /* 分段策略：以 8 小节（短歌 4 小节）为基本格点保证颗粒度，
   * 再把每个格点吸附到 ±2 小节内新颖度最高的位置，让边界尽量落在真实的段落换点上。
   * 纯靠换点检测会切得忽长忽短，纯靠固定格点又会切在乐句中间，两者结合最稳。 */
  function sectionBounds(vectors) {
    const barCount = vectors.length;
    const smooth = noveltyCurve(vectors);
    const cell = barCount >= 40 ? 8 : 4;
    const noveltyFloor = percentile([...smooth], 0.58);
    const bounds = [0];
    for (let grid = cell; grid <= barCount - 4; grid += cell) {
      let best = grid;
      let bestValue = -1;
      for (let k = Math.max(2, grid - 2); k <= Math.min(barCount - 3, grid + 2); k += 1) {
        if (smooth[k] > bestValue) {
          bestValue = smooth[k];
          best = k;
        }
      }
      const previous = bounds[bounds.length - 1];
      const snapped = best > previous + 3 && bestValue >= noveltyFloor ? best : grid;
      if (snapped > previous + 3 && snapped < barCount - 2) bounds.push(snapped);
    }
    bounds.push(barCount);
    return bounds;
  }

  function segmentFeatures(vectors, fromBar, toBar) {
    const seq = vectors.slice(fromBar, toBar);
    const bars = Math.max(1, seq.length);
    let energy = 0;
    let onset = 0;
    let centroid = 0;
    for (const vector of seq) {
      energy += vector.energy;
      onset += vector.onset;
      centroid += vector.centroid;
    }
    return { seq, bars, energy: energy / bars, onset: onset / bars, centroid: centroid / bars };
  }

  /* 段落相似度：按相对位置逐小节对齐比较，而不是只比"平均向量"。
   * 两段副歌的平均能量也许和主歌差不多，但它们随时间的起伏形状是独有的，
   * 对齐比较才能把"同一段再次出现"认出来。 */
  function segmentSimilarity(a, b) {
    const steps = Math.min(24, a.seq.length, b.seq.length);
    if (!steps) return 0;
    let sum = 0;
    for (let k = 0; k < steps; k += 1) {
      const ai = a.seq[Math.min(a.seq.length - 1, Math.floor(((k + 0.5) * a.seq.length) / steps))];
      const bi = b.seq[Math.min(b.seq.length - 1, Math.floor(((k + 0.5) * b.seq.length) / steps))];
      sum += frameSimilarity(ai, bi);
    }
    return sum / steps;
  }

  /* 贪心聚类。阈值必须用"分布相对判据"而不是一个绝对数字——
   * 相似度的绝对尺度取决于各特征权重，写死 0.76 这种值，换个权重就整段失效。
   * 这里的判据是：一对段落要算"同一段再次出现"，得同时满足
   *   ① 落在最相似的那 20% 里；② 明显高于中位数（中位数 + 1.5 倍绝对中位差）。
   * 两条都过，才认为是真的重复，避免把"都不太像"的歌硬凑出组来。 */
  function groupSegments(features) {
    const pairs = [];
    for (let i = 0; i < features.length; i += 1) {
      for (let j = i + 1; j < features.length; j += 1) pairs.push(segmentSimilarity(features[i], features[j]));
    }
    const threshold = pairs.length
      ? Math.max(percentile(pairs, 0.8), median(pairs) + mad(pairs) * 1.5)
      : 1;

    const groups = [];
    features.forEach((feature, index) => {
      let best = null;
      let bestScore = 0;
      for (const group of groups) {
        // 与组内成员逐一比较后取平均，比只看第一个成员稳
        let sum = 0;
        for (const member of group.members) sum += segmentSimilarity(features[member], feature);
        const score = sum / group.members.length;
        if (score > bestScore) {
          bestScore = score;
          best = group;
        }
      }
      if (best && bestScore >= threshold) best.members.push(index);
      else groups.push({ members: [index] });
    });
    return { groups, threshold };
  }

  function buildStructure(analysis, duration) {
    const { barCount, barDuration, barPhaseSeconds } = analysis;
    const vectors = barVectors(analysis);
    const bounds = sectionBounds(vectors);
    const starts = bounds;

    const features = [];
    for (let i = 0; i < starts.length - 1; i += 1) features.push(segmentFeatures(vectors, starts[i], starts[i + 1]));

    const { groups } = groupSegments(features);
    const stats = groups.map((group, id) => ({
      id,
      count: group.members.length,
      energy: group.members.reduce((sum, i) => sum + features[i].energy, 0) / group.members.length,
      bars: group.members.reduce((sum, i) => sum + features[i].bars, 0) / group.members.length,
      first: Math.min(...group.members)
    }));
    const groupOf = new Array(features.length);
    groups.forEach((group, id) => group.members.forEach(member => { groupOf[member] = id; }));

    const repeated = stats.filter(item => item.count >= 2);
    let chorusId;
    if (repeated.length) {
      // 重复出现的段落里最"满"的那一组就是副歌
      chorusId = [...repeated].sort((a, b) => (b.energy - a.energy) || (b.bars - a.bars) || (a.first - b.first))[0].id;
    } else {
      chorusId = [...stats].sort((a, b) => b.energy - a.energy)[0].id;
    }
    const verseIds = new Set(repeated.filter(item => item.id !== chorusId).map(item => item.id));

    const energies = features.map(feature => feature.energy);
    const medianEnergy = median(energies);
    const types = new Array(features.length).fill(null);

    features.forEach((feature, index) => {
      const id = groupOf[index];
      const isFirst = index === 0;
      const isLast = index === features.length - 1;
      const position = index / Math.max(1, features.length - 1);
      const veryQuiet = feature.energy < medianEnergy * 0.5;
      // 首尾段落：本身就是独一份，或者明显比全曲安静，就是前奏 / 尾奏
      if (isFirst && (stats[id].count === 1 || veryQuiet)) {
        types[index] = 'intro';
        return;
      }
      if (isLast) {
        // 结尾依然很满，多半是最后一次副歌（升调或加花），按副歌算更安全：
        // 若误判成尾奏，用户很可能把整首歌最好听的段落给排除了。
        if (feature.energy >= medianEnergy && id !== chorusId) {
          types[index] = 'chorus';
          return;
        }
        if (stats[id].count === 1 || veryQuiet) {
          types[index] = 'outro';
          return;
        }
      }
      // 曲子尾部安静下来的段落也归尾奏（尾奏常常不止一段，拆成"间奏＋尾奏"没有意义）
      if (position > 0.8 && feature.energy < medianEnergy * 0.4) {
        types[index] = 'outro';
        return;
      }
      // 通篇明显安静的段落是间奏——它可能恰好与某个主歌分到同一组，但听感上是间奏。
      // 开头那几小节不算：刚起唱时的安静是主歌的常态，不是间奏。
      if (position > 0.12 && feature.energy < medianEnergy * 0.35) {
        types[index] = 'interlude';
        return;
      }
      if (id === chorusId) {
        types[index] = 'chorus';
        return;
      }
      if (verseIds.has(id)) {
        types[index] = 'verse';
        return;
      }
      const leadsIntoChorus = index + 1 < features.length && groupOf[index + 1] === chorusId;
      if (leadsIntoChorus && feature.energy < features[index + 1].energy) {
        types[index] = 'prechorus';
        return;
      }
      if (index >= Math.floor(features.length / 3) && feature.energy >= medianEnergy * 0.9) {
        types[index] = 'bridge';
        return;
      }
      if (feature.energy < medianEnergy * 0.75) {
        types[index] = 'interlude';
        return;
      }
      types[index] = 'verse';
    });

    const raw = [];
    for (let index = 0; index < features.length; index += 1) {
      const startBar = Math.max(0, Math.min(barCount, starts[index]));
      const endBar = Math.max(startBar, Math.min(barCount, starts[index + 1]));
      let start = index === 0 ? 0 : barPhaseSeconds + startBar * barDuration;
      let end = index === features.length - 1 ? duration : barPhaseSeconds + endBar * barDuration;
      start = Math.max(0, Math.min(duration, start));
      end = Math.max(start + 0.1, Math.min(duration, end));
      raw.push({
        start,
        end,
        type: types[index],
        energy: features[index].energy,
        bars: features[index].bars,
        group: groupOf[index]
      });
    }

    /* 相邻同类段落合成一段，否则会出现"主歌1、主歌2"紧挨着这种别扭结果。
     * 但加上长度上限：流行歌里单个段落很少超过 24 小节，
     * 若不加限制，一串安静的小节会被并成一个一分钟长的"主歌"，反而更不准。 */
    const MAX_SECTION_BARS = 24;
    const merged = [];
    for (const item of raw) {
      const previous = merged[merged.length - 1];
      if (previous && previous.type === item.type && previous.bars + item.bars <= MAX_SECTION_BARS) {
        previous.energy = (previous.energy * previous.bars + item.energy * item.bars) / (previous.bars + item.bars);
        previous.end = item.end;
        previous.bars += item.bars;
      } else {
        merged.push({ ...item });
      }
    }

    // 给会多次出现的段落编号（主歌1 / 主歌2 / 副歌1 …）
    const totals = {};
    merged.forEach(item => { totals[item.type] = (totals[item.type] || 0) + 1; });
    const counters = {};
    merged.forEach(item => {
      counters[item.type] = (counters[item.type] || 0) + 1;
      const repeatable = item.type === 'verse' || item.type === 'chorus' || item.type === 'prechorus' || item.type === 'interlude';
      const numbered = repeatable && totals[item.type] > 1;
      item.label = `${SECTION_TYPES[item.type].label}${numbered ? counters[item.type] : ''}`;
      item.selected = true;
    });
    return merged;
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

  function musicalCrossfade(analysis) {
    // 按 A/B 双轨思路让前段淡出、后段淡入。重叠约四分之三拍：足以形成
    // 听得见的缓冲，又不会覆盖完整一拍而把两个重音叠成抢拍。
    return Math.max(0.22, Math.min(0.48, analysis.beatDuration * 0.72));
  }

  function buildPlan(buffer, targetSeconds, analysis, strategy) {
    const { barDuration, barCount, barEnergy } = analysis;
    const origin = analysis.barPhaseSeconds || 0;
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
      { start: 0, end: Math.min(buffer.duration, origin + introBars * barDuration), role: '开头' },
      { start: origin + middleStart * barDuration, end: Math.min(buffer.duration, origin + (middleStart + middleBars) * barDuration), role: '核心段落' },
      { start: Math.max(0, origin + outroStart * barDuration), end: buffer.duration, role: '原曲结尾' }
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
      crossfadeSeconds: musicalCrossfade(analysis),
      cutMode: '小节起点对齐 · A/B 轨等功率交叉淡化'
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

  function vocalCutSafety(analysis, seconds) {
    const activity = analysis.vocalActivity;
    const step = analysis.vocalSecondsPerFrame;
    if (!activity?.length || !step) return 0.5;
    const center = Math.max(0, Math.min(activity.length - 1, Math.round(seconds / step)));
    const centerRadius = Math.max(1, Math.round(0.11 / step));
    const contextRadius = Math.max(centerRadius + 1, Math.round(0.85 / step));
    let centerTotal = 0;
    let centerCount = 0;
    let contextTotal = 0;
    let contextCount = 0;
    for (let i = Math.max(0, center - contextRadius); i <= Math.min(activity.length - 1, center + contextRadius); i += 1) {
      contextTotal += activity[i];
      contextCount += 1;
      if (Math.abs(i - center) <= centerRadius) {
        centerTotal += activity[i];
        centerCount += 1;
      }
    }
    const centerMean = centerTotal / Math.max(1, centerCount);
    const contextMean = contextTotal / Math.max(1, contextCount);
    const relativeGap = Math.max(0, Math.min(1, 0.5 + (contextMean - centerMean) * 1.8));
    const absoluteGap = 1 - Math.max(0, Math.min(1, centerMean));
    return relativeGap * 0.68 + absoluteGap * 0.32;
  }

  function featureAtTime(analysis, seconds) {
    const origin = analysis.barPhaseSeconds || 0;
    const bar = Math.max(0, Math.min(analysis.barCount - 1, Math.floor((seconds - origin) / analysis.barDuration)));
    const chroma = new Float32Array(12);
    const base = bar * 12;
    for (let c = 0; c < 12; c += 1) chroma[c] = analysis.barChroma[base + c];
    return {
      chroma,
      energy: analysis.barEnergy[bar],
      onset: analysis.barOnset[bar],
      centroid: analysis.barCentroid[bar]
    };
  }

  function transitionCompatibility(analysis, previousEnd, nextStart) {
    if (!Number.isFinite(previousEnd)) return 0.7;
    const before = featureAtTime(analysis, Math.max(0, previousEnd - analysis.beatDuration * 0.5));
    const after = featureAtTime(analysis, nextStart + analysis.beatDuration * 0.5);
    return frameSimilarity(before, after);
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
    // 将每段长度量化到整拍，并用最大余数法分配剩余拍数。这样总长度最多只差一拍，
    // 不需要在渲染阶段拉伸整首音频来凑时长。
    const beat = analysis.beatDuration;
    const capacities = ranges.map(range => Math.max(0, Math.floor((range.end - range.start) / beat)));
    const targetBeats = Math.min(
      capacities.reduce((sum, value) => sum + value, 0),
      Math.max(ranges.length, Math.ceil(requestedDuration / beat))
    );
    const exact = allocations.map(value => value / beat);
    const units = exact.map((value, index) => Math.min(capacities[index], Math.max(capacities[index] ? 1 : 0, Math.floor(value))));
    let assigned = units.reduce((sum, value) => sum + value, 0);
    const order = exact.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
      .sort((a, b) => b.remainder - a.remainder);
    while (assigned < targetBeats) {
      const candidate = order.find(item => units[item.index] < capacities[item.index]);
      if (!candidate) break;
      units[candidate.index] += 1;
      assigned += 1;
      candidate.remainder = -1;
      order.sort((a, b) => b.remainder - a.remainder);
    }
    while (assigned > targetBeats) {
      const candidate = [...order].reverse().find(item => units[item.index] > 1);
      if (!candidate) break;
      units[candidate.index] -= 1;
      assigned -= 1;
    }
    return units.map((value, index) => value > 0 ? Math.min(ranges[index].end - ranges[index].start, value * beat) : 0);
  }

  function chooseWindowInRange(range, duration, analysis, strategy, rangeIndex, previousSegment = null) {
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
    const alignedDuration = Math.min(capacity, Math.max(analysis.beatDuration, duration));
    if (range.start < origin && origin > 0.01) {
      const musicalEnd = Math.min(gridEnd, Math.max(origin, alignNearest(range.start + duration)));
      return { start: range.start, end: musicalEnd };
    }
    if (alignedDuration >= capacity - 0.02) return { start: gridStart, end: gridEnd };
    const step = analysis.beatDuration;
    let bestStart = gridStart;
    let bestScore = -Infinity;
    for (let start = gridStart; start <= gridEnd - alignedDuration + 0.01; start += step) {
      const energy = rangeEnergy(analysis, start, start + alignedDuration);
      const center = start + alignedDuration * 0.5;
      const rangeCenter = gridStart + capacity * 0.5;
      const position = 1 - Math.min(1, Math.abs(center - rangeCenter) / Math.max(barDuration, capacity * 0.5));
      const transition = transitionCompatibility(analysis, previousSegment?.end, start);
      const startSafety = start <= 0.02 ? 1 : vocalCutSafety(analysis, start);
      const endSafety = vocalCutSafety(analysis, start + alignedDuration);
      const lyricSafety = Math.min(startSafety, endSafety);
      const beatOffset = Math.abs(Math.round((start - origin) / analysis.beatDuration)) % (analysis.beatsPerBar || 4);
      const phraseAlignment = beatOffset === 0 ? 1 : 0.55;
      let score = lyricSafety * 0.42 + energy * 0.28 + transition * 0.22 + phraseAlignment * 0.08;
      if (strategy === 'balanced') score = lyricSafety * 0.42 + transition * 0.28 + position * 0.2 + phraseAlignment * 0.1;
      if (strategy === 'smooth') score = lyricSafety * 0.46 + transition * 0.38 + position * 0.1 + phraseAlignment * 0.06;
      if (score > bestScore) {
        bestScore = score;
        bestStart = start;
      }
    }
    return { start: bestStart, end: Math.min(gridEnd, bestStart + alignedDuration) };
  }

  function chooseNarrativeArc(ranges, analysis, strategy) {
    if (ranges.length < 4) return null;
    const introIndex = Math.max(0, ranges.findIndex(range => range.type === 'intro'));
    let outroIndex = -1;
    for (let i = ranges.length - 1; i >= 0; i -= 1) {
      if (ranges[i].type === 'outro') { outroIndex = i; break; }
    }
    if (outroIndex < 0) outroIndex = ranges.length - 1;
    const verseIndexes = ranges.map((range, index) => range.type === 'verse' ? index : -1)
      .filter(index => index > introIndex && index < outroIndex);
    const chorusIndexes = ranges.map((range, index) => range.type === 'chorus' ? index : -1)
      .filter(index => index > introIndex && index < outroIndex);
    let middleIndexes = ranges.map((range, index) => ['interlude', 'bridge'].includes(range.type) ? index : -1)
      .filter(index => index > introIndex && index < outroIndex);
    if (!middleIndexes.length) {
      middleIndexes = ranges.map((range, index) => !['intro', 'verse', 'chorus', 'outro'].includes(range.type) ? index : -1)
        .filter(index => index > introIndex && index < outroIndex);
    }
    if (!verseIndexes.length || !chorusIndexes.length || !middleIndexes.length) return null;

    let best = null;
    for (const verseIndex of verseIndexes) {
      for (const chorusIndex of chorusIndexes) {
        if (chorusIndex <= verseIndex) continue;
        for (const middleIndex of middleIndexes) {
          if (middleIndex <= chorusIndex || middleIndex >= outroIndex) continue;
          const indexes = [introIndex, verseIndex, chorusIndex, middleIndex, outroIndex];
          const positions = indexes.map(index => index / Math.max(1, ranges.length - 1));
          const idealVersePosition = strategy === 'balanced' ? 0.1 : strategy === 'smooth' ? 0.28 : 0.2;
          const positionScore = 1 - (
            Math.abs(positions[1] - idealVersePosition) + Math.abs(positions[2] - 0.43) + Math.abs(positions[3] - 0.65)
          ) / 3;
          const verseEnergy = rangeEnergy(analysis, ranges[verseIndex].start, ranges[verseIndex].end);
          const chorusEnergy = rangeEnergy(analysis, ranges[chorusIndex].start, ranges[chorusIndex].end);
          const middleEnergy = rangeEnergy(analysis, ranges[middleIndex].start, ranges[middleIndex].end);
          const outroEnergy = rangeEnergy(analysis, ranges[outroIndex].start, ranges[outroIndex].end);
          const energyArc = Math.max(0, Math.min(1, 0.55 + (chorusEnergy - verseEnergy) * 0.7
            + (chorusEnergy - middleEnergy) * 0.25 + (middleEnergy - outroEnergy) * 0.2));
          let transition = 0;
          for (let i = 1; i < indexes.length; i += 1) {
            transition += transitionCompatibility(analysis, ranges[indexes[i - 1]].end, ranges[indexes[i]].start);
          }
          transition /= indexes.length - 1;
          let score = positionScore * 0.44 + energyArc * 0.34 + transition * 0.22;
          if (strategy === 'energy') score = chorusEnergy * 0.38 + energyArc * 0.32 + positionScore * 0.2 + transition * 0.1;
          if (strategy === 'smooth') score = transition * 0.48 + positionScore * 0.28 + energyArc * 0.24;
          if (strategy === 'balanced' && verseIndex === verseIndexes[0]) score += 0.16;
          if (strategy === 'smooth' && verseIndex === verseIndexes.filter(index => index < chorusIndex).at(-1)) score += 0.08;
          if (!best || score > best.score) best = { score, indexes };
        }
      }
    }
    return best?.indexes || null;
  }

  function chooseNarrativeWindow(range, desiredDuration, analysis, strategy, role, previousSegment, bufferDuration) {
    const barDuration = analysis.barDuration;
    const origin = analysis.barPhaseSeconds || 0;
    const alignUp = time => origin + Math.ceil((time - origin - 0.01) / barDuration) * barDuration;
    const alignDown = time => origin + Math.floor((time - origin + 0.01) / barDuration) * barDuration;
    // 前奏必须带上歌曲真正的开头，尾奏必须落到歌曲真正的结尾。中间段落才
    // 使用检测到的小节网格收窄边界。
    const gridStart = role === 'intro' ? range.start : Math.max(range.start, alignUp(range.start));
    const gridEnd = role === 'outro' ? range.end : Math.min(range.end, alignDown(range.end));
    const capacityBars = Math.floor((gridEnd - gridStart) / barDuration);
    if (capacityBars < 2) return { start: range.start, end: range.end, role: range.role };

    const vocalRole = role === 'verse' || role === 'chorus';
    const unitBars = vocalRole ? 4 : 2;
    // 主歌和副歌至少保留 8 小节，避免只拿半句话；前奏和尾奏至少 4 小节，
    // 间奏可保留 2 小节作为呼吸。参考时长过短时宁可自然超出。
    const preferredMinimum = vocalRole ? 8 : role === 'interlude' ? 2 : 4;
    const minBars = Math.min(capacityBars, preferredMinimum);
    const candidates = [];
    for (let bars = minBars; bars <= capacityBars; bars += unitBars) {
      const duration = bars * barDuration;
      const starts = [];
      if (role === 'intro') starts.push(gridStart);
      else if (role === 'outro') starts.push(gridEnd - duration);
      else for (let start = gridStart; start <= gridEnd - duration + 0.01; start += barDuration) starts.push(start);
      for (const start of starts) {
        const end = Math.min(gridEnd, start + duration);
        const startNatural = Math.abs(start - range.start) < 0.08 || start <= 0.08;
        const endNatural = Math.abs(end - range.end) < 0.08 || end >= bufferDuration - 0.08;
        const startSafety = startNatural ? 0.72 : vocalCutSafety(analysis, start);
        const endSafety = endNatural ? 0.72 : vocalCutSafety(analysis, end);
        // 每一个被截短的片段都必须落在安静气口。间奏和尾奏也可能带和声或
        // 尾句，不能因为标签看起来像“器乐段”就允许从持续发声处切开。
        if (startSafety < 0.52 || endSafety < 0.52) continue;
        const durationScore = Math.exp(-Math.abs(duration - desiredDuration) / Math.max(barDuration * 2, desiredDuration * 0.45));
        const lyricSafety = Math.min(startSafety, endSafety);
        const transition = previousSegment ? transitionCompatibility(analysis, previousSegment.end, start) : 0.75;
        const energy = rangeEnergy(analysis, start, end);
        let rolePosition = 0.7;
        if (role === 'intro') rolePosition = 1 - (start - gridStart) / Math.max(barDuration, gridEnd - gridStart);
        if (role === 'outro') rolePosition = 1 - (gridEnd - end) / Math.max(barDuration, gridEnd - gridStart);
        if (role === 'verse' && strategy === 'balanced') rolePosition = 1 - (start - gridStart) / Math.max(barDuration, gridEnd - gridStart);
        if (role === 'verse' && strategy === 'energy') rolePosition = (start - gridStart) / Math.max(barDuration, gridEnd - gridStart);
        let score = durationScore * 0.34 + lyricSafety * 0.31 + transition * 0.2 + rolePosition * 0.1 + energy * 0.05;
        if (strategy === 'energy' && role === 'chorus') score += energy * 0.12;
        if (strategy === 'smooth') score += transition * 0.1;
        candidates.push({ start, end, role: range.role, score });
      }
    }
    if (!candidates.length) return { start: range.start, end: range.end, role: range.role };
    candidates.sort((a, b) => b.score - a.score);
    const chosen = candidates[0];
    return { start: chosen.start, end: chosen.end, role: chosen.role };
  }

  function buildNarrativePlan(buffer, targetSeconds, analysis, strategy, ranges) {
    const indexes = chooseNarrativeArc(ranges, analysis, strategy);
    if (!indexes) return null;
    const roles = ['intro', 'verse', 'chorus', 'interlude', 'outro'];
    const weights = [0.14, 0.24, 0.3, 0.14, 0.18];
    const segments = [];
    indexes.forEach((rangeIndex, index) => {
      const range = ranges[rangeIndex];
      const previous = segments[segments.length - 1] || null;
      const window = chooseNarrativeWindow(
        range,
        targetSeconds * weights[index],
        analysis,
        strategy,
        roles[index],
        previous,
        buffer.duration
      );
      segments.push(window);
    });

    const merged = [];
    for (const segment of segments) {
      const previous = merged[merged.length - 1];
      if (previous && segment.start - previous.end <= Math.max(0.08, analysis.beatDuration * 0.22)) {
        previous.end = segment.end;
        previous.role += `＋${segment.role}`;
      } else {
        merged.push({ ...segment });
      }
    }
    const crossfadeSeconds = merged.length > 1 ? musicalCrossfade(analysis) : 0;
    const naturalDuration = merged.reduce((sum, segment) => sum + segment.end - segment.start, 0)
      - Math.max(0, merged.length - 1) * crossfadeSeconds;
    const selectedEnergy = merged.reduce((sum, segment) => sum + rangeEnergy(analysis, segment.start, segment.end), 0) / Math.max(1, merged.length);
    return {
      strategy,
      name: '候选方案',
      description: '前奏—主歌—副歌—间奏—尾奏的完整迷你歌曲结构。',
      requestedSeconds: targetSeconds,
      targetSeconds: naturalDuration,
      durationVarianceSeconds: naturalDuration - targetSeconds,
      segments: merged,
      cutCount: Math.max(0, merged.length - 1),
      selectedEnergy,
      targetBars: Math.max(1, Math.round(naturalDuration / analysis.barDuration)),
      crossfadeSeconds,
      cutMode: '五段叙事结构 · 完整歌词乐句 · A/B 轨交叉淡化',
      transitionGainMatching: true,
      narrativeArc: true
    };
  }

  function buildConstrainedPlan(buffer, targetSeconds, analysis, strategy, allowedRanges) {
    const ranges = normalizeAllowedRanges(buffer, allowedRanges);
    if (!ranges.length) throw new Error('请至少选择一个参与重编排的歌曲段落。');
    const narrativePlan = buildNarrativePlan(buffer, targetSeconds, analysis, strategy, ranges);
    if (narrativePlan) return narrativePlan;
    const availableDuration = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
    const maxRanges = targetSeconds < 40 ? 4 : targetSeconds < 100 ? 6 : 8;
    const tolerance = Math.max(analysis.barDuration * 4, targetSeconds * 0.18);
    const lastIndex = ranges.length - 1;
    let best = null;

    const evaluate = indexes => {
      const picked = indexes.map(index => ranges[index]);
      const lastChorusIndex = [...indexes].reverse().find(index => ranges[index].type === 'chorus');
      if (lastChorusIndex !== undefined) {
        const chosen = new Set(indexes);
        // 选到最后一次高潮后，就必须保留其后的连续过渡与尾奏；禁止再次跳切。
        for (let index = lastChorusIndex + 1; index <= lastIndex; index += 1) {
          if (!chosen.has(index)) return;
        }
      }
      const rawDuration = picked.reduce((sum, range) => sum + range.end - range.start, 0);
      if (availableDuration >= targetSeconds * 0.65 && rawDuration < targetSeconds * 0.65) return;
      const durationDifference = Math.abs(rawDuration - targetSeconds);
      const durationScore = Math.exp(-durationDifference / Math.max(1, tolerance));
      const types = new Set(picked.map(range => range.type));
      const hasVerse = types.has('verse');
      const hasChorus = types.has('chorus');
      const hasEnding = types.has('outro') || picked[picked.length - 1].end >= buffer.duration - 0.2;
      const narrative = (hasVerse ? 0.28 : 0) + (hasChorus ? 0.36 : 0)
        + (hasEnding ? 0.26 : 0) + (types.has('intro') ? 0.1 : 0);
      let transitionTotal = 0;
      let dynamicTotal = 0;
      let safetyTotal = 0;
      let adjacencyCount = 0;
      for (let i = 0; i < picked.length; i += 1) {
        const range = picked[i];
        safetyTotal += Math.min(vocalCutSafety(analysis, range.start), vocalCutSafety(analysis, range.end));
        if (i === 0) continue;
        const previous = picked[i - 1];
        const adjacent = range.start - previous.end <= Math.max(0.08, analysis.beatDuration * 0.22);
        const joinSafety = Math.min(vocalCutSafety(analysis, previous.end), vocalCutSafety(analysis, range.start));
        // 非连续片段的两侧只要仍有明显人声，就直接淘汰该方案。
        // 宁可让成片时长浮动，也不能用淡化掩盖半句歌词被截断的问题。
        if (!adjacent && joinSafety < 0.52) return;
        if (adjacent) adjacencyCount += 1;
        transitionTotal += Math.min(1, transitionCompatibility(analysis, previous.end, range.start) + (adjacent ? 0.28 : 0));
        const beforeEnergy = rangeEnergy(analysis, previous.start, previous.end);
        const afterEnergy = rangeEnergy(analysis, range.start, range.end);
        const drop = Math.max(0, beforeEnergy - afterEnergy);
        // 高潮到低能尾奏只有在原曲本来连续时才自然；跨段跳过去要重罚。
        const dropPenalty = drop * (range.type === 'outro' && !adjacent ? 1.8 : 0.9);
        dynamicTotal += Math.max(0, 1 - dropPenalty);
      }
      const joins = Math.max(1, picked.length - 1);
      const transition = picked.length > 1 ? transitionTotal / joins : 0.65;
      const dynamics = picked.length > 1 ? dynamicTotal / joins : 0.65;
      const safety = safetyTotal / Math.max(1, picked.length);
      const adjacency = adjacencyCount / joins;
      const artificialCuts = Math.max(0, picked.length - 1 - adjacencyCount);
      const meanEnergy = picked.reduce((sum, range) => sum + rangeEnergy(analysis, range.start, range.end), 0) / picked.length;
      let score;
      if (strategy === 'energy') {
        score = durationScore * 0.3 + narrative * 0.24 + transition * 0.17
          + dynamics * 0.12 + meanEnergy * 0.12 + adjacency * 0.05;
        if (picked[0]?.type === 'chorus') score += 0.08;
        if (artificialCuts === 0 && rawDuration >= targetSeconds) score += 0.13;
      } else if (strategy === 'smooth') {
        score = transition * 0.24 + dynamics * 0.18 + adjacency * 0.28
          + safety * 0.1 + durationScore * 0.1 + narrative * 0.06;
        if (adjacency >= 0.99) score += 0.14;
        if (artificialCuts === 0) score += 0.08;
      } else {
        score = durationScore * 0.38 + narrative * 0.25 + transition * 0.16
          + dynamics * 0.1 + safety * 0.07 + adjacency * 0.04;
        if (picked[0]?.type === 'verse') score += 0.2;
        score -= artificialCuts * 0.075;
        if (picked[0] && picked[0].end - picked[0].start < analysis.barDuration * 6) score -= 0.09;
        if (artificialCuts === 0) score += 0.11;
      }
      const preferredCount = strategy === 'energy' ? 3 : strategy === 'smooth' ? 5 : 4;
      score -= Math.abs(picked.length - preferredCount) * 0.012;
      // 超出参考时长很多仍可候选，但必须有显著更好的叙事与衔接才会胜出。
      if (durationDifference > Math.max(tolerance * 2.2, targetSeconds * 0.42)) score -= 0.3;
      if (!best || score > best.score) best = { score, indexes, picked, rawDuration };
    };

    // 结尾必须来自用户允许范围中的最后一个完整段落；此前最多选择若干完整乐段。
    // 组合数在常见的 8–16 个段落下很小，能换来比贪心截断稳定得多的结构。
    let searchPool = ranges.slice(0, lastIndex).map((_, index) => index);
    if (searchPool.length > 15) {
      const kept = new Set([0, 1, lastIndex - 1, lastIndex - 2, lastIndex - 3].filter(index => index >= 0));
      const ranked = searchPool
        .filter(index => !kept.has(index))
        .map(index => ({
          index,
          score: (ranges[index].type === 'chorus' ? 1 : ranges[index].type === 'verse' ? 0.7 : 0.35)
            + rangeEnergy(analysis, ranges[index].start, ranges[index].end) * 0.45
        }))
        .sort((a, b) => b.score - a.score);
      ranked.slice(0, 15 - kept.size).forEach(item => kept.add(item.index));
      searchPool = [...kept].sort((a, b) => a - b);
    }
    const choose = (from, remaining, current) => {
      evaluate([...current, lastIndex]);
      if (remaining <= 0) return;
      for (let position = from; position < searchPool.length; position += 1) {
        const index = searchPool[position];
        current.push(index);
        choose(position + 1, remaining - 1, current);
        current.pop();
      }
    };
    choose(0, Math.max(0, maxRanges - 1), []);

    const selected = best?.picked || [ranges[lastIndex]];
    const segments = [];
    for (const range of selected) {
      const previous = segments[segments.length - 1];
      const adjacent = previous && range.start - previous.end <= Math.max(0.08, analysis.beatDuration * 0.22);
      if (adjacent) {
        // 保留原曲里本来就连续的“高潮→过渡→尾奏”，不在中间制造人工接点。
        previous.end = range.end;
        previous.role += `＋${range.role}`;
      } else {
        segments.push({ start: range.start, end: range.end, role: range.role });
      }
    }

    const crossfadeSeconds = segments.length > 1 ? musicalCrossfade(analysis) : 0;
    const naturalDuration = segments.reduce((sum, segment) => sum + segment.end - segment.start, 0)
      - Math.max(0, segments.length - 1) * crossfadeSeconds;
    const selectedEnergy = segments.reduce((sum, segment) => sum + rangeEnergy(analysis, segment.start, segment.end), 0) / Math.max(1, segments.length);
    return {
      strategy,
      name: '候选方案',
      description: '以参考时长为中心，优先保留完整乐句与自然收束。',
      requestedSeconds: targetSeconds,
      targetSeconds: naturalDuration,
      durationVarianceSeconds: naturalDuration - targetSeconds,
      segments,
      cutCount: Math.max(0, segments.length - 1),
      selectedEnergy,
      targetBars: Math.max(1, Math.round(naturalDuration / analysis.barDuration)),
      crossfadeSeconds,
      cutMode: '完整乐段优先 · 自然时长浮动 · A/B 轨交叉淡化',
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
    const plannedLength = Math.max(0, rawEnd - rawStart);
    let startFrame = rawStart === 0 ? 0 : findQuietCrossing(guide, rawStart, radius);
    let endFrame = Math.min(buffer.length, startFrame + plannedLength);
    if (endFrame - startFrame < plannedLength) startFrame = Math.max(0, endFrame - plannedLength);
    const length = Math.max(0, endFrame - startFrame);
    const count = Math.min(buffer.numberOfChannels, 2);
    const channels = [];
    for (let c = 0; c < count; c += 1) channels.push(buffer.getChannelData(c).slice(startFrame, endFrame));
    return { channels, length };
  }

  function stitchSegments(buffer, plan) {
    const pieces = plan.segments.map(segment => copySegment(buffer, segment));
    const crossfadeFrames = Math.round(buffer.sampleRate * (plan.crossfadeSeconds ?? 0.12));
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

  function trimPlanToTarget(plan, analysis) {
    const segments = plan.segments.map(segment => ({ ...segment }));
    const overlap = Math.max(0, plan.crossfadeSeconds || 0);
    let renderedDuration = segments.reduce((sum, segment) => sum + segment.end - segment.start, 0)
      - Math.max(0, segments.length - 1) * overlap;
    let excess = Math.max(0, renderedDuration - plan.targetSeconds);
    // 任意目标时长不一定正好落在整拍上。旧实现总是截短最后一段，可能正好切在一句歌词中间。
    // 现在会在所有片段的头尾中寻找“移动同样时长以后最像歌词气口”的那个接点。
    if (excess > 1e-4) {
      const options = [];
      segments.forEach((segment, index) => {
        if (segment.end - segment.start - excess < 0.2) return;
        const shortenedEnd = segment.end - excess;
        options.push({
          index,
          edge: 'end',
          score: vocalCutSafety(analysis, shortenedEnd) * 0.78 + vocalCutSafety(analysis, segment.start) * 0.22
        });
        const advancedStart = segment.start + excess;
        options.push({
          index,
          edge: 'start',
          score: vocalCutSafety(analysis, advancedStart) * 0.78 + vocalCutSafety(analysis, segment.end) * 0.22
        });
      });
      options.sort((a, b) => b.score - a.score);
      const best = options[0];
      if (best) {
        if (best.edge === 'end') segments[best.index].end -= excess;
        else segments[best.index].start += excess;
        renderedDuration -= excess;
        excess = 0;
      }
    }
    // 极短片段等异常输入的保底逻辑。
    for (let index = segments.length - 1; index >= 0 && excess > 1e-4; index -= 1) {
      const duration = segments[index].end - segments[index].start;
      const reducible = Math.max(0, duration - 0.2);
      const amount = Math.min(reducible, excess);
      segments[index].end -= amount;
      excess -= amount;
      renderedDuration -= amount;
    }
    const joinSafeties = [];
    segments.forEach((segment, index) => {
      if (index > 0) joinSafeties.push(vocalCutSafety(analysis, segment.start));
      if (index < segments.length - 1) joinSafeties.push(vocalCutSafety(analysis, segment.end));
    });
    return {
      ...plan,
      segments,
      lyricSafety: joinSafeties.length ? Math.min(...joinSafeties) : vocalCutSafety(analysis, segments[0]?.end || 0),
      lyricsProtected: true
    };
  }

  function fitToExactLength(channels, targetLength) {
    const sourceLength = channels[0].length;
    if (sourceLength === targetLength) return channels;
    if (sourceLength > targetLength) return channels.map(source => source.slice(0, targetLength));
    // 正常规划会多留不足一拍的余量；这里仅是容错，不进行会改变速度和音高的重采样。
    return channels.map(source => {
      const output = new Float32Array(targetLength);
      output.set(source, 0);
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

  function buildWaveformPeaks(channels, pointCount = 1800) {
    const length = channels[0]?.length || 0;
    const count = Math.max(1, Math.min(pointCount, length));
    const peaks = new Float32Array(count);
    for (let point = 0; point < count; point += 1) {
      const from = Math.floor((point / count) * length);
      const to = Math.max(from + 1, Math.floor(((point + 1) / count) * length));
      const stride = Math.max(1, Math.floor((to - from) / 48));
      let peak = 0;
      for (let frame = from; frame < to; frame += stride) {
        for (const channel of channels) peak = Math.max(peak, Math.abs(channel[frame] || 0));
      }
      peaks[point] = peak;
    }
    return peaks;
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

  async function renderPlan(buffer, plan, analysis, progress = () => {}) {
    const renderedPlan = trimPlanToTarget(plan, analysis);
    let channels = stitchSegments(buffer, renderedPlan);
    progress(62, '正在构建候选方案…');
    const targetLength = Math.max(1, Math.round(plan.targetSeconds * buffer.sampleRate));
    channels = fitToExactLength(channels, targetLength);
    applyMasterFade(channels, buffer.sampleRate);
    normalize(channels);
    const waveformPeaks = buildWaveformPeaks(channels);
    const wavBytes = encodeWav(channels, buffer.sampleRate);
    return {
      ...renderedPlan,
      bpm: null,
      waveformPeaks,
      wavBytes,
      blob: new Blob([wavBytes], { type: 'audio/wav' })
    };
  }

  async function process(buffer, targetSeconds, requestedStrategy, progress = () => {}, precomputedAnalysis = null, allowedRanges = null) {
    if (targetSeconds < 8) throw new Error('参考时长至少需要 8 秒。');
    if (targetSeconds >= buffer.duration - 1) throw new Error('参考时长需要短于原曲至少 1 秒。');
    progress(3, '读取音频波形…');
    await new Promise(resolve => setTimeout(resolve, 30));
    const analysis = precomputedAnalysis || await analyzeRhythm(buffer, progress);
    const strategies = requestedStrategy === 'all' ? ['energy', 'balanced', 'smooth'] : [requestedStrategy];
    const results = [];
    for (let i = 0; i < strategies.length; i += 1) {
      const strategy = strategies[i];
      const plan = allowedRanges
        ? buildConstrainedPlan(buffer, targetSeconds, analysis, strategy, allowedRanges)
        : buildPlan(buffer, targetSeconds, analysis, strategy);
      const base = 46 + (i / strategies.length) * 48;
      progress(base, `正在生成方案 ${String.fromCharCode(65 + i)}…`);
      const result = await renderPlan(buffer, plan, analysis, progress);
      result.bpm = analysis.bpm;
      result.barDuration = analysis.barDuration;
      results.push(result);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    progress(100, '重编排完成');
    return { analysis, results };
  }

  window.VistaAudio = { decodeFile, analyze: analyzeRhythm, buildSections: buildStructure, SECTION_TYPES, process, STRATEGIES };
})();
