/**
 * FFmpeg WASM 视频合成导出（带音频极速版）
 *
 * 优化策略：
 *  - 高 CRF (35) + ultrafast preset 提速
 *  - 24fps 降帧率
 *  - 统一并规整化所有分段的音频轨（双声道 44100Hz AAC），无音频则自动垫底静音，确保 concat 成功
 *  - 等待循环段只生成并打包一次，利用 concat 文件列表多次播放
 */
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const WAIT_SPLIT_TIME = 2;

// ── FFmpeg 实例缓存 ──
let cachedFFmpeg = null;
let loadingPromise = null;

export async function getFFmpegInstance(onLog) {
  if (cachedFFmpeg) return cachedFFmpeg;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const ffmpeg = new FFmpeg();
    if (onLog) ffmpeg.on('log', ({ message }) => onLog(message));
    const baseURL = window.location.origin + '/ffmpeg';
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    cachedFFmpeg = ffmpeg;
    loadingPromise = null;
    return ffmpeg;
  })();

  return loadingPromise;
}

function even(n) {
  return Math.floor(n / 2) * 2;
}

function getVideoDuration(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.src = url;
    v.preload = 'metadata';
    v.onloadedmetadata = () => resolve(v.duration);
    v.onerror = () => resolve(0);
  });
}

const V_FAST = [
  '-c:v', 'libx264',
  '-preset', 'fast',
  '-crf', '18',
  '-pix_fmt', 'yuv420p',
  '-color_primaries', 'bt709',
  '-color_trc', 'bt709',
  '-colorspace', 'bt709'
];
const FPS = 24;

/**
 * 极速截取视频片段（仅用于提取小切片）
 * 采用 `-c copy`，理论上极快，但由于关键帧问题可能会有稍微的误差。
 */
export async function cutVideoSegment({ videoSrc, startTime, duration, onLog, cropArea = null, videoNaturalSize = null, reverse = false }) {
  const ffmpeg = await getFFmpegInstance(onLog);
  const inputName = `input_${Date.now()}.mp4`;
  const outputName = `slice_${Date.now()}.mp4`;

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(videoSrc));
    
    if (cropArea && videoNaturalSize) {
      // 保证宽高是偶数，这是 x264 编码器的要求
      const cW = even(cropArea.width);
      const cH = even(cropArea.height);
      const cX = even(cropArea.x);
      const cY = even(cropArea.y);
      
      let vf = `crop=${cW}:${cH}:${cX}:${cY}`;
      if (reverse) vf += ',reverse';

      await ffmpeg.exec([
        '-y', '-ss', `${startTime}`, '-t', `${duration}`,
        '-i', inputName,
        '-vf', vf,
        ...V_FAST,
        '-c:a', 'copy',
        outputName
      ]);
    } else {
      if (reverse) {
        await ffmpeg.exec([
          '-y', '-ss', `${startTime}`, '-t', `${duration}`,
          '-i', inputName,
          '-vf', 'reverse',
          ...V_FAST,
          '-c:a', 'copy',
          outputName
        ]);
      } else {
        // 不裁剪且反正放时直接复制音视频流，实现秒切。
        await ffmpeg.exec([
          '-y', '-ss', `${startTime}`, '-t', `${duration}`,
          '-i', inputName,
          '-c', 'copy',
          outputName
        ]);
      }
    }
    
    const data = await ffmpeg.readFile(outputName);
    return new Blob([data.buffer], { type: 'video/mp4' });
  } finally {
    try { await ffmpeg.deleteFile(inputName); } catch (_) {}
    try { await ffmpeg.deleteFile(outputName); } catch (_) {}
  }
}

export async function extractVideoFrame({ videoSrc, time, onLog, cropArea = null, videoNaturalSize = null }) {
  const ffmpeg = await getFFmpegInstance(onLog);
  const inputName = `input_frame_${Date.now()}.mp4`;
  const outputName = `frame_${Date.now()}.png`;

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(videoSrc));
    
    let vfFilter = '';
    if (cropArea && videoNaturalSize) {
      const cW = even(cropArea.width);
      const cH = even(cropArea.height);
      const cX = even(cropArea.x);
      const cY = even(cropArea.y);
      vfFilter = `crop=${cW}:${cH}:${cX}:${cY}`;
    }

    const args = [
      '-y', '-ss', `${time}`, '-i', inputName,
      '-vframes', '1'
    ];
    if (vfFilter) {
      args.push('-vf', vfFilter);
    }
    args.push(outputName);

    await ffmpeg.exec(args);
    
    const data = await ffmpeg.readFile(outputName);
    return new Blob([data.buffer], { type: 'image/png' });
  } finally {
    try { await ffmpeg.deleteFile(inputName); } catch (_) {}
    try { await ffmpeg.deleteFile(outputName); } catch (_) {}
  }
}

/**
 * 截取视频并生成 正放+倒放拼接 的视频
 */
export async function cutBoomerangVideoSegment({ videoSrc, startTime, duration, onLog, cropArea = null, videoNaturalSize = null, reverse = false }) {
  const ffmpeg = await getFFmpegInstance(onLog);
  const inputName = `input_${Date.now()}.mp4`;
  const outputName = `boomerang_${Date.now()}.mp4`;

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(videoSrc));
    
    let cropFilter = '';
    if (cropArea && videoNaturalSize) {
      const cW = even(cropArea.width);
      const cH = even(cropArea.height);
      const cX = even(cropArea.x);
      const cY = even(cropArea.y);
      cropFilter = `crop=${cW}:${cH}:${cX}:${cY},`;
    }

    // 基础处理：统一帧率为 25fps（便于精确计算时长），并精确截取目标时长
    const baseFilter = `${cropFilter}fps=25,trim=duration=${duration},setpts=PTS-STARTPTS`;

    // 正放 + 倒放 拼接 (reverse = true 表示 倒放 + 正放)
    // 通过在 split 之前进行精确 trim，保证 A 和 reversed(A) 的帧数绝对一致，从而保证首尾帧完全相同
    let filterComplex = '';
    if (reverse) {
      filterComplex = `[0:v]${baseFilter},split=2[v1_raw][v2];[v1_raw]reverse[v1];[v1][v2]concat=n=2:v=1:a=0[outv]`;
    } else {
      filterComplex = `[0:v]${baseFilter},split=2[v1][v2_raw];[v2_raw]reverse[v2];[v1][v2]concat=n=2:v=1:a=0[outv]`;
    }

    await ffmpeg.exec([
      '-y', '-ss', `${startTime}`, '-t', `${duration + 0.5}`, // 稍微多读一点输入，确保 trim 过滤器有足够的数据
      '-i', inputName,
      '-filter_complex', filterComplex,
      '-map', '[outv]',
      ...V_FAST,
      '-an', // 移除音频，正反放的音频通常不需要
      outputName
    ]);
    
    const data = await ffmpeg.readFile(outputName);
    return new Blob([data.buffer], { type: 'video/mp4' });
  } finally {
    try { await ffmpeg.deleteFile(inputName); } catch (_) {}
    try { await ffmpeg.deleteFile(outputName); } catch (_) {}
  }
}

/**
 * 逆向截取视频并生成 倒放+正放拼接 的视频
 * 适用于 duration 为负数的情况（例如从 startTime 向前截取 |duration| 秒）。
 * 截取出的片段 [startTime - |duration|, startTime] 会先被**倒放**（时间从 startTime 倒退），
 * 然后再**正放**（时间回到 startTime），从而保证最终拼接视频的**第一帧和最后一帧**都是原视频的 startTime 帧。
 */
export async function cutBackwardBoomerangVideoSegment({ videoSrc, startTime, duration, onLog, cropArea = null, videoNaturalSize = null, reverse = false }) {
  const ffmpeg = await getFFmpegInstance(onLog);
  const inputName = `input_bw_${Date.now()}.mp4`;
  const outputName = `boomerang_bw_${Date.now()}.mp4`;

  // 计算实际的截取起点和持续时间
  const actualDuration = Math.abs(duration);
  const actualStartTime = Math.max(0, startTime - actualDuration);

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(videoSrc));
    
    let cropFilter = '';
    if (cropArea && videoNaturalSize) {
      const cW = even(cropArea.width);
      const cH = even(cropArea.height);
      const cX = even(cropArea.x);
      const cY = even(cropArea.y);
      cropFilter = `crop=${cW}:${cH}:${cX}:${cY},`;
    }

    // 基础处理：统一帧率为 25fps，精确截取目标时长
    const baseFilter = `${cropFilter}fps=25,trim=duration=${actualDuration},setpts=PTS-STARTPTS`;

    // 默认行为：截取出的片段先倒放，再正放
    // 这意味着 A片段 [8, 10] 提取出来后：
    // v1 = reversed(A) （即时间线 10 -> 8）
    // v2 = A （即时间线 8 -> 10）
    // 拼接结果 v1 + v2 （10 -> 8 -> 10），使得首尾两帧绝对等于 10s 处的帧
    let filterComplex = '';
    if (reverse) {
      // 如果调用方还传了 reverse = true，则翻转逻辑：正放 + 倒放 (8->10->8)
      filterComplex = `[0:v]${baseFilter},split=2[v1][v2_raw];[v2_raw]reverse[v2];[v1][v2]concat=n=2:v=1:a=0[outv]`;
    } else {
      // 默认情况：倒放 + 正放 (10->8->10)
      filterComplex = `[0:v]${baseFilter},split=2[v1_raw][v2];[v1_raw]reverse[v1];[v1][v2]concat=n=2:v=1:a=0[outv]`;
    }

    await ffmpeg.exec([
      '-y', '-ss', `${actualStartTime}`, '-t', `${actualDuration + 0.5}`, // 稍微多读一点输入，确保 trim 过滤器有足够的数据
      '-i', inputName,
      '-filter_complex', filterComplex,
      '-map', '[outv]',
      ...V_FAST,
      '-an', // 移除音频
      outputName
    ]);
    
    const data = await ffmpeg.readFile(outputName);
    return new Blob([data.buffer], { type: 'video/mp4' });
  } finally {
    try { await ffmpeg.deleteFile(inputName); } catch (_) {}
    try { await ffmpeg.deleteFile(outputName); } catch (_) {}
  }
}

/**
 * 将等待视频拆分为：0-2s部分、剩余部分、0-2s的倒放部分
 * 返回包含这三个 blob 的对象
 */
export async function splitWaitingVideo(videoSrc, onLog) {
  const ffmpeg = await getFFmpegInstance(onLog);
  const inputName = `wait_in_${Date.now()}.mp4`;
  const first2sName = `wait_2s_${Date.now()}.mp4`;
  const restName = `wait_rest_${Date.now()}.mp4`;
  const first2sRevName = `wait_2s_rev_${Date.now()}.mp4`;

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(videoSrc));
    
    // 我们强制所有分段在处理时，不仅通过 V_FAST 重编，还加入 scale 让它们的画幅严格对齐原始输入，以防某些滤镜缩放问题
    // 使用 filter_complex 先获得输入视频的信息，或者直接设置安全的 scale
    const baseFilter = `fps=25,setpts=PTS-STARTPTS`;

    // 1. 截取前 2s
    // 由于后续要播放/叠加，而且使用了 copy 可能会因为关键帧 (I-frame) 不对齐导致首帧缩放/黑屏
    // 这里放弃 copy，全部走 V_FAST 重新编码，确保画幅一致性
    await ffmpeg.exec([
      '-y', '-i', inputName,
      '-t', '2',
      '-vf', baseFilter,
      ...V_FAST,
      '-an',
      first2sName
    ]);

    // 2. 截取 2s 后的部分
    // 同样放弃 copy，强制重编，避免时间戳、分辨率或容器信息不一致
    await ffmpeg.exec([
      '-y', '-ss', '2', '-i', inputName,
      '-vf', baseFilter,
      ...V_FAST,
      '-an',
      restName
    ]);

    // 3. 生成前 2s 的倒放
    // reverse 滤镜加上 setpts
    await ffmpeg.exec([
      '-y', '-i', first2sName,
      '-vf', `reverse,${baseFilter}`,
      ...V_FAST,
      '-an',
      first2sRevName
    ]);

    const first2sData = await ffmpeg.readFile(first2sName);
    const restData = await ffmpeg.readFile(restName);
    const first2sRevData = await ffmpeg.readFile(first2sRevName);

    return {
      first2s: new Blob([first2sData.buffer], { type: 'video/mp4' }),
      rest: new Blob([restData.buffer], { type: 'video/mp4' }),
      first2sRev: new Blob([first2sRevData.buffer], { type: 'video/mp4' }),
    };
  } finally {
    try { await ffmpeg.deleteFile(inputName); } catch (_) {}
    try { await ffmpeg.deleteFile(first2sName); } catch (_) {}
    try { await ffmpeg.deleteFile(restName); } catch (_) {}
    try { await ffmpeg.deleteFile(first2sRevName); } catch (_) {}
  }
}

/**
 * 将裁剪后的生成视频覆盖（贴合）到全局底图上的对应坐标，合成一个完整画幅的视频。
 * 用于导出项目时生成视觉上完整的视频。
 */
export async function overlayVideoOnImage({ videoUrl, imageBlob, cropArea, videoNaturalSize, onLog }) {
  if (!videoUrl || !imageBlob || !cropArea) return videoUrl;
  
  const ffmpeg = await getFFmpegInstance(onLog);
  const inputVideoName = `overlay_in_v_${Date.now()}.mp4`;
  const inputImageName = `overlay_in_i_${Date.now()}.png`;
  const outputName = `overlay_out_${Date.now()}.mp4`;

  try {
    await ffmpeg.writeFile(inputVideoName, await fetchFile(videoUrl));
    await ffmpeg.writeFile(inputImageName, await fetchFile(imageBlob));

    // 确保贴图坐标是偶数，防止 ffmpeg 报错
    const cX = even(cropArea.x);
    const cY = even(cropArea.y);

    await ffmpeg.exec([
      '-y',
      '-loop', '1', '-i', inputImageName, // 输入 0：底图，循环播放
      '-i', inputVideoName,               // 输入 1：裁剪视频
      '-filter_complex', `[0:v][1:v]overlay=${cX}:${cY}:shortest=1[outv]`, // 叠加，并且以较短的（视频）为结束标志
      '-map', '[outv]',
      '-map', '1:a?',                     // 尝试映射可能存在的音频轨
      ...V_FAST,
      outputName
    ]);
    
    const data = await ffmpeg.readFile(outputName);
    const resultBlob = new Blob([data.buffer], { type: 'video/mp4' });
    return URL.createObjectURL(resultBlob);
  } catch (error) {
    console.error('Failed to overlay video on image', error);
    return videoUrl; // 如果合成失败，退回使用原本的裁剪视频
  } finally {
    try { await ffmpeg.deleteFile(inputVideoName); } catch (_) {}
    try { await ffmpeg.deleteFile(inputImageName); } catch (_) {}
    try { await ffmpeg.deleteFile(outputName); } catch (_) {}
  }
}

export async function exportCompositeFFmpeg({
  videoSrc,
  sortedNodes,
  waitLoopCount = 3,
  onProgress,
  onLog,
}) {
  onProgress?.('正在加载 FFmpeg...');
  const ffmpeg = await getFFmpegInstance(onLog);
  const cleanupFiles = [];

  try {
    // ── 1. 写入原视频 ──
    onProgress?.('加载原视频...');
    await ffmpeg.writeFile('original.mp4', await fetchFile(videoSrc));
    cleanupFiles.push('original.mp4');

    const natW = even(sortedNodes[0]?.videoNaturalSize?.width || 1280);
    const natH = even(sortedNodes[0]?.videoNaturalSize?.height || 720);

    // ── 2. 写入各节点视频 ──
    onProgress?.('加载节点视频...');
    const waitDurations = [];
    for (let ni = 0; ni < sortedNodes.length; ni++) {
      const node = sortedNodes[ni];
      if (node.guidanceVideo) {
        const name = `g_${ni}.mp4`;
        await ffmpeg.writeFile(name, await fetchFile(node.guidanceVideo));
        cleanupFiles.push(name);
      }
      if (node.feedbackVideo) {
        const name = `f_${ni}.mp4`;
        await ffmpeg.writeFile(name, await fetchFile(node.feedbackVideo));
        cleanupFiles.push(name);
      }
      const waitSrc = node.waitingVideo
        ? (typeof node.waitingVideo === 'string' ? node.waitingVideo : node.waitingVideo?.original ?? node.waitingVideo?.forward)
        : null;
      if (waitSrc) {
        const name = `w_${ni}.mp4`;
        await ffmpeg.writeFile(name, await fetchFile(waitSrc));
        cleanupFiles.push(name);
        waitDurations[ni] = await getVideoDuration(waitSrc);
      }
    }

    // ── 通用段落处理引擎 （保证视频和标准的音频轨配对）
    async function processSegment(vArgs, audioExtractArgs, outName, label) {
      onProgress?.(label);
      const vOnlyName = outName.replace('.mp4', '_v.mp4');
      await ffmpeg.exec([...vArgs, '-an', vOnlyName]);
      cleanupFiles.push(vOnlyName);

      const aName = outName.replace('.mp4', '_a.aac');
      let hasAudio = false;
      if (audioExtractArgs && audioExtractArgs.length > 0) {
        const retA = await ffmpeg.exec([
          ...audioExtractArgs, '-vn',
          '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k', aName
        ]);
        if (retA === 0) hasAudio = true;
      }

      if (hasAudio) {
        await ffmpeg.exec([
          '-y', '-i', vOnlyName, '-i', aName,
          '-c:v', 'copy', '-c:a', 'copy', '-shortest', outName
        ]);
        try { await ffmpeg.deleteFile(aName); } catch (_) {}
      } else {
        await ffmpeg.exec([
          '-y', '-i', vOnlyName,
          '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
          '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k', '-shortest', outName
        ]);
      }
      cleanupFiles.push(outName);
      try { await ffmpeg.deleteFile(vOnlyName); } catch (_) {}
    }

    // ── 增量合并函数 ──
    let hasOutput = false;
    async function appendToOutput(segmentName, label, deleteAfter = true) {
      onProgress?.(`合并片段: ${label}...`);
      if (!hasOutput) {
        // 第一次直接重命名
        await ffmpeg.exec(['-y', '-i', segmentName, '-c', 'copy', 'output.mp4']);
        hasOutput = true;
      } else {
        // 增量合并
        await ffmpeg.writeFile('concat.txt', `file 'output.mp4'\nfile '${segmentName}'`);
        await ffmpeg.exec([
          '-y', '-f', 'concat', '-safe', '0', '-i', 'concat.txt',
          '-c', 'copy', '-movflags', '+faststart',
          'temp_output.mp4',
        ]);
        try { await ffmpeg.deleteFile('output.mp4'); } catch (_) {}
        await ffmpeg.exec(['-y', '-i', 'temp_output.mp4', '-c', 'copy', 'output.mp4']);
        try { await ffmpeg.deleteFile('temp_output.mp4'); } catch (_) {}
        try { await ffmpeg.deleteFile('concat.txt'); } catch (_) {}
      }
      // 合并完成后立即删除该分段，释放内存
      if (deleteAfter) {
        try { await ffmpeg.deleteFile(segmentName); } catch (_) {}
      }
    }

    // ── 3. 逐节点生成段落 ──
    let prevTime = 0;
    const total = sortedNodes.length;

    for (let ni = 0; ni < total; ni++) {
      const node = sortedNodes[ni];
      const crop = node.cropArea;
      const tag = total > 1 ? ` [${ni + 1}/${total}]` : '';
      const cW = even(crop?.width || 256);
      const cH = even(crop?.height || 256);
      const cX = crop?.x || 0;
      const cY = crop?.y || 0;

      // ── 3a. 原视频段
      const segDur = node.interactionTime - prevTime;
      if (segDur > 0.05) {
        const sName = `so_${ni}.mp4`;
        await processSegment(
          ['-y', '-ss', `${prevTime}`, '-t', `${segDur}`, '-i', 'original.mp4', '-r', `${FPS}`, ...V_FAST], // Video args
          ['-y', '-ss', `${prevTime}`, '-t', `${segDur}`, '-i', 'original.mp4'], // Audio args
          sName,
          `截取原视频...${tag}`
        );
        await appendToOutput(sName, `原视频片段${tag}`);
      }

      // ── 3b. 提取静帧
      onProgress?.(`提取静帧...${tag}`);
      const freezeName = `fr_${ni}.jpg`;
      await ffmpeg.exec([
        '-y', '-ss', `${node.interactionTime}`,
        '-i', 'original.mp4', '-vframes', '1',
        '-q:v', '5', freezeName,
      ]);
      cleanupFiles.push(freezeName);

      // ── overlay 辅助
      const makeOverlay = async (overlayInput, outName, label) => {
        await processSegment(
          [
            '-y', '-loop', '1', '-framerate', `${FPS}`, '-i', freezeName,
            '-i', overlayInput,
            '-filter_complex', `[0:v]scale=${natW}:${natH}[bg];[1:v]scale=${cW}:${cH}[ov];[bg][ov]overlay=${cX}:${cY}:shortest=1[v]`,
            '-map', '[v]', '-r', `${FPS}`, ...V_FAST, '-shortest'
          ],
          ['-y', '-i', overlayInput], // Extract full audio from the overlay clip itself
          outName,
          `${label}...${tag}`
        );
      };

      // ── 3c. 引导语
      if (node.guidanceVideo) {
        const sName = `sg_${ni}.mp4`;
        await makeOverlay(`g_${ni}.mp4`, sName, '引导语叠加');
        await appendToOutput(sName, `引导语叠加${tag}`);
      }

      // ── 3d. 等待循环
      const waitSrc = node.waitingVideo ? (typeof node.waitingVideo === 'string' ? node.waitingVideo : (node.waitingVideo?.original ?? node.waitingVideo?.forward)) : null;
      if (waitSrc) {
        const waitDur = waitDurations[ni] || 8;

        // wait1_fwd: 0→WAIT_SPLIT_TIME
        const w1f = `w1f_${ni}.mp4`;
        await processSegment(
          [
            '-y', '-loop', '1', '-framerate', `${FPS}`, '-i', freezeName, '-i', `w_${ni}.mp4`,
            '-filter_complex', `[0:v]scale=${natW}:${natH}[bg];[1:v]trim=0:${WAIT_SPLIT_TIME},setpts=PTS-STARTPTS,scale=${cW}:${cH}[wv];[bg][wv]overlay=${cX}:${cY}:shortest=1:eof_action=endall[v]`,
            '-map', '[v]', '-t', `${WAIT_SPLIT_TIME}`, '-r', `${FPS}`, ...V_FAST
          ],
          ['-y', '-ss', '0', '-t', `${WAIT_SPLIT_TIME}`, '-i', `w_${ni}.mp4`],
          w1f,
          `等待-进入...${tag}`
        );
        await appendToOutput(w1f, `等待-进入${tag}`);

        // wait2_fwd: WAIT_SPLIT_TIME→end
        const w2f = `w2f_${ni}.mp4`;
        await processSegment(
          [
            '-y', '-loop', '1', '-framerate', `${FPS}`, '-i', freezeName, '-i', `w_${ni}.mp4`,
            '-filter_complex', `[0:v]scale=${natW}:${natH}[bg];[1:v]trim=${WAIT_SPLIT_TIME}:${waitDur},setpts=PTS-STARTPTS,scale=${cW}:${cH}[wv];[bg][wv]overlay=${cX}:${cY}:shortest=1:eof_action=endall[v]`,
            '-map', '[v]', '-r', `${FPS}`, ...V_FAST
          ],
          ['-y', '-ss', `${WAIT_SPLIT_TIME}`, '-t', `${waitDur - WAIT_SPLIT_TIME}`, '-i', `w_${ni}.mp4`],
          w2f,
          `等待-循环体...${tag}`
        );

        // wait2_rev:倒放
        const w2r = `w2r_${ni}.mp4`;
        // using audio-reversing 'areverse' alongside video reverse
        await processSegment(
           [
             '-y', '-i', w2f, '-vf', 'reverse', '-r', `${FPS}`, ...V_FAST
           ],
           ['-y', '-i', w2f, '-af', 'areverse'], // Reverse the audio of w2f
           w2r,
           `等待-倒放...${tag}`
        );

        // loop wait LoopCount
        for (let loop = 0; loop < waitLoopCount; loop++) {
          await appendToOutput(w2f, `等待-循环体 ${loop+1}/${waitLoopCount}${tag}`, false);
          await appendToOutput(w2r, `等待-倒放 ${loop+1}/${waitLoopCount}${tag}`, false);
        }
        try { await ffmpeg.deleteFile(w2f); } catch (_) {}
        try { await ffmpeg.deleteFile(w2r); } catch (_) {}

        const w1r = `w1r_${ni}.mp4`;
        await processSegment(
           [
             '-y', '-i', w1f, '-vf', 'reverse', '-r', `${FPS}`, ...V_FAST
           ],
           ['-y', '-i', w1f, '-af', 'areverse'],
           w1r,
           `等待-退出...${tag}`
        );
        await appendToOutput(w1r, `等待-退出${tag}`);
      }

      // ── 3e. 反馈语
      if (node.feedbackVideo) {
        const sName = `sf_${ni}.mp4`;
        await makeOverlay(`f_${ni}.mp4`, sName, '反馈语叠加');
        await appendToOutput(sName, `反馈语叠加${tag}`);
      }

      prevTime = node.interactionTime;
    }

    // ── 4. 原视频尾段
    const origDur = await getVideoDuration(videoSrc);
    const tailDur = origDur - prevTime;
    if (tailDur > 0.05) {
      const tName = `tail.mp4`;
      await processSegment(
        ['-y', '-ss', `${prevTime}`, '-i', 'original.mp4', '-r', `${FPS}`, ...V_FAST],
        ['-y', '-ss', `${prevTime}`, '-i', 'original.mp4'],
        tName,
        '原视频收尾...'
      );
      await appendToOutput(tName, '原视频尾段');
    }

    // ── 5. 生成 blob
    onProgress?.('生成文件...');
    const data = await ffmpeg.readFile('output.mp4');
    cleanupFiles.push('output.mp4');
    return new Blob([data.buffer], { type: 'video/mp4' });
  } finally {
    for (const f of [...new Set(cleanupFiles)]) {
      try { await ffmpeg.deleteFile(f); } catch (_) {}
    }
  }
}
