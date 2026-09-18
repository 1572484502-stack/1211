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
  const SPECTRAL_HIGH_HZ = 2000;

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

  async function spectralFrames(mono, sampleRate, progress = () => {}) {
    const { signal, rate } = decimate(mono, sampleRate);
    const overlap = rate / sampleRate; // 抽取比例，用于把抽帧位置换算回原秒数
    const frameCount = Math.max(1, Math.floor((signal.length - FFT_SIZE) / FFT_HOP) + 1);
    const chromaFrames = new Float32Array(frameCount * 12);
    const centroids = new Float32Array(frameCount);
    const window = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i += 1) {
      window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
    }
    const re = new Float32Array(FFT_SIZE);
    const im = new Float32Array(FFT_SIZE);
    const binHz = rate / FFT_SIZE;
    const lowBin = Math.max(1, Math.floor(SPECTRAL_LOW_HZ / binHz));
    const highBin = Math.min(FFT_SIZE / 2, Math.ceil(SPECTRAL_HIGH_HZ / binHz));

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
        const magnitude = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        if (magnitude <= 0) continue;
        const frequency = k * binHz;
        const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
        const pitchClass = ((midi % 12) + 12) % 12;
        chromaFrames[base + pitchClass] += magnitude;
        sum += magnitude;
        weighted += frequency * magnitude;
      }
      let norm = 0;
      for (let c = 0; c < 12; c += 1) norm += chromaFrames[base + c] * chromaFrames[base + c];
      norm = Math.sqrt(norm);
      if (norm > 1e-9) {
        for (let c = 0; c < 12; c += 1) chromaFrames[base + c] /= norm;
      }
      centroids[frame] = sum > 1e-9 ? weighted / sum : 0;

      if (frame % 200 === 0) {
        progress(38 + (frame / frameCount) * 16, '分析和声与音色，寻找重复段落…');
        await yieldToUi();
      }
    }
    return { chromaFrames, centroids, frameCount, secondsPerFrame: (FFT_HOP * overlap) / sampleRate };
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
      if (bpm % 30 === 0) await yieldToUi();
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

    const spectral = await spectralFrames(mono, sampleRate, progress);
    const barChroma = new Float32Array(barCount * 12);
    const barCentroid = new Float32Array(barCount);
    for (let bar = 0; bar < barCount; bar += 1) {
      const startSeconds = barPhaseSeconds + bar * barDuration;
      const endSeconds = Math.min(buffer.duration, startSeconds + barDuration);
      const from = Math.max(0, Math.floor(startSeconds / spectral.secondsPerFrame));
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

  /* 小节级相似度。
   * 权重是按"对段落识别有多管用"排的，而不是听起来多专业：
   * 实测流行歌整首和弦高度接近，纯靠色度算相似度会全部落在 0.9 以上、完全分不开段；
   * 力度（能量）与鼓点密度才是真正把主歌和副歌分开的量；明亮度次之；色度只做兜底。 */
  function frameSimilarity(a, b) {
    let dot = 0;
    for (let i = 0; i < 12; i += 1) dot += a.chroma[i] * b.chroma[i];
    const tone = Math.max(0, dot);
    const power = 1 - Math.min(1, Math.abs(a.energy - b.energy) * 2.2);
    const drive = 1 - Math.min(1, Math.abs(a.onset - b.onset) * 2.0);
    const colour = 1 - Math.min(1, Math.abs(a.centroid - b.centroid) * 1.8);
    return tone * 0.24 + power * 0.34 + drive * 0.24 + colour * 0.18;
  }

  // 新颖度：某小节前后各 4 小节互不相似的程度，峰值就是段落换点
  function noveltyCurve(vectors) {
    const barCount = vectors.length;
    const span = 4;
    const raw = new Float32Array(barCount);
    for (let i = span; i <= barCount - span; i += 1) {
      let sum = 0;
      for (let p = 0; p < span; p += 1) {
        for (let q = 0; q < span; q += 1) sum += frameSimilarity(vectors[i - span + p], vectors[i + q]);
      }
      raw[i] = 1 - sum / (span * span);
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
    const cell = barCount >= 48 ? 8 : 4;
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
      const snapped = best > previous + 3 ? best : grid;
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

  /* 贪心聚类。阈值不写死，取"比大多数段间相似度明显更高"的那一档；
   * 用中位数 + 绝对中位差而不是均值 + 标准差，避免个别离群段（比如很安静的引子）把阈值算飞。 */
  function groupSegments(features) {
    const pairs = [];
    for (let i = 0; i < features.length; i += 1) {
      for (let j = i + 1; j < features.length; j += 1) pairs.push(segmentSimilarity(features[i], features[j]));
    }
    const threshold = pairs.length ? Math.max(0.76, median(pairs) + mad(pairs) * 0.9) : 1;

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
      const result = await renderPlan(buffer, plan, progress);
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
