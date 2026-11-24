import { containingFrame, nearestFrame, seekSeconds } from "./time";
import type { Recording } from "./package";
import type { RecordDiagnostic } from "../lib/diagnostics";
import { SMPLX_NUM_JOINTS, SMPLX_NUM_VERTS } from "../smplx/skeleton";
import type { BodyFrame } from "./engine";
import type { DisplayMode } from "./displayMode";

type Output = {
  present: (
    body: BodyFrame,
    index: number,
    images: HTMLCanvasElement[],
  ) => void;
  update: (frame: number, busy: boolean, playing: boolean) => void;
  error: (message: string) => void;
  diagnose: RecordDiagnostic;
};
const BODY_LOOKAHEAD_NS = 1e9, BODY_CACHE_AHEAD = 64, IMAGE_CACHE_BYTES = 64 * 1024 ** 2;

export function startPlayback(
  descriptor: Recording,
  host: HTMLElement,
  output: Output,
  mode: DisplayMode,
) {
  const jointWidth = SMPLX_NUM_JOINTS * 3;
  const vertexWidth = SMPLX_NUM_VERTS * 3;
  const { diagnose } = output;
  const playbackStartedAt = performance.now();
  const frameBytes = descriptor.cameras.reduce((sum, camera) => sum + camera.image_size[0] * camera.image_size[1] * 4, 0);
  const imageCacheFrames = Math.max(2, Math.min(12, Math.floor(IMAGE_CACHE_BYTES / Math.max(1, frameBytes))));
  const videos = descriptor.cameras.map((camera) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = camera.url;
    host.append(video);
    return video;
  });
  const images = videos.map(() => new Map<number, HTMLCanvasElement>()),
    bodyFrames = new Map<number, BodyFrame>();
  let shownImages: HTMLCanvasElement[] = [];
  const callbacks: number[] = [],
    listeners: Array<() => void> = [],
    mediaTimeMs: number[] = [];
  let workerJob: { first: number; count: number; revision: number; startedAt: number } | null = null;
  let seekStartedAt: number | null = null;
  let disposed = false,
    failed = false,
    playing = false,
    frame = 0,
    shown = -1,
    wanted: number | null = 0,
    pendingFrame: number | null = null,
    revision = 0,
    busy = true,
    resuming = false,
    stalledAt = playbackStartedAt,
    lastStallLogAt = -Infinity;
  const pause = () => videos.forEach((video) => video.pause());
  const notify = () => output.update(frame, busy, playing);
  function canAdvance(index: number) {
    return [...images[index].keys()].filter(ordinal => ordinal > shown).length < imageCacheFrames;
  }
  function bodyAt(index: number) {
    const body = bodyFrames.get(index);
    return mode === "mesh" && !body?.vertices ? undefined : body;
  }
  function pruneBodies() {
    for (const index of bodyFrames.keys())
      if ((index !== pendingFrame && (index < frame - 2 || index >= frame + (playing ? BODY_CACHE_AHEAD : 8)))
        || !bodyAt(index))
        bodyFrames.delete(index);
  }
  function prefetch() {
    if (disposed || failed || workerJob || !playing || wanted !== null || shown < 0) return;
    let first = shown + 1;
    while (bodyAt(first)) first++;
    if (first < descriptor.frames && first < shown + BODY_CACHE_AHEAD
      && descriptor.relative_timestamps_ns[first] - descriptor.relative_timestamps_ns[shown] < BODY_LOOKAHEAD_NS)
      void fetchFrames(first);
  }
  function releaseAhead() {
    const target = wanted ?? pendingFrame ?? shown;
    images.forEach((cache, i) => {
      for (const [ordinal, image] of cache)
        if (ordinal !== target) dropCachedImage(i, ordinal, image);
    });
    pruneBodies();
  }
  function snapshot() {
    const cameras = videos.map((video, i) => {
      const cache = images[i], camera = descriptor.cameras[i];
      const canvases = cache.size + Number(!!shownImages[i] && cache.get(shown) !== shownImages[i]);
      return {
        view: camera.view_id, width: camera.image_size[0], height: camera.image_size[1],
        currentTimeMs: Math.round(video.currentTime * 1000), lastVideoFrameMs: mediaTimeMs[i] ?? null,
        readyState: video.readyState, networkState: video.networkState, seeking: video.seeking, paused: video.paused,
        ended: video.ended, cachedFrames: cache.size, targetCached: wanted === null ? null : cache.has(wanted),
        canvasBytes: canvases * camera.image_size[0] * camera.image_size[1] * 4,
      };
    });
    return {
      frame, shown, wanted, pendingFrame, revision, busy, playing, resuming, mode,
      visibility: document.visibilityState,
      targetJointsCached: wanted === null ? null : !!bodyAt(wanted), jointCacheFrames: bodyFrames.size,
      bodyCacheBytes: [...new Set([...bodyFrames.values()].flatMap(body =>
        [body.joints.buffer, ...(body.vertices ? [body.vertices.buffer] : [])]))].reduce((sum, buffer) => sum + buffer.byteLength, 0),
      imageCacheFrames,
      canvasBytes: cameras.reduce((sum, camera) => sum + camera.canvasBytes, 0),
      worker: workerJob ? { ...workerJob, elapsedMs: Math.round(performance.now() - workerJob.startedAt) } : null,
      cameras,
    };
  }
  function releaseImage(image: HTMLCanvasElement) {
    // Drop the pixel backing store independently of when the browser runs GC.
    image.width = 0;
    image.height = 0;
  }
  function dropCachedImage(i: number, ordinal: number, image: HTMLCanvasElement) {
    images[i].delete(ordinal);
    if (image !== shownImages[i]) releaseImage(image);
  }
  function pruneImages(i: number, oldest: number) {
    const cache = images[i];
    for (const [ordinal, image] of cache)
      if (ordinal < oldest || cache.size > imageCacheFrames) dropCachedImage(i, ordinal, image);
  }
  const fail = (error: unknown, stage: string) => {
    if (!disposed && !failed) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      diagnose("playback.failed", { stage, timedOut: message.includes("超时"), ...snapshot() });
      playing = false;
      pause();
      notify();
      output.error(message);
    }
  };
  async function fetchFrames(first: number) {
    if (workerJob || disposed || failed) return;
    const count = Math.min(8, descriptor.frames - first);
    if (count < 1) return;
    const mesh = mode === "mesh";
    const job = { first, count, revision, mode, startedAt: performance.now() };
    workerJob = job;
    const foreground = busy;
    if (foreground) diagnose("playback.worker_started", job);
    let outcome = "ready";
    let computeMs: number | null = null;
    try {
      const { joints, vertices, computeMs: elapsed } = await descriptor.engine.frames(first, count, mesh);
      computeMs = elapsed;
      if (disposed || failed || job.revision !== revision) {
        outcome = "superseded";
        return;
      }
      if (joints.length !== count * jointWidth || !joints.every(Number.isFinite)
        || (mesh && (vertices?.length !== count * vertexWidth || !vertices.every(Number.isFinite))))
        throw new Error("人体帧与当前时间不一致");
      for (let i = 0; i < count; i++)
        bodyFrames.set(first + i, {
          joints: joints.subarray(i * jointWidth, (i + 1) * jointWidth),
          vertices: vertices?.subarray(i * vertexWidth, (i + 1) * vertexWidth),
        });
    } catch (error) {
      outcome = "failed";
      if (job.revision === revision) fail(error, "worker_frames");
    } finally {
      workerJob = null;
      if (!disposed) {
        const durationMs = Math.round(performance.now() - job.startedAt);
        if (foreground || busy || durationMs >= 500 || outcome !== "ready")
          diagnose("playback.worker_finished", { ...job, computeMs, durationMs, outcome });
        tryPresent();
        pruneBodies();
        prefetch();
      }
    }
  }
  function capture(index: number, stamp: number, presented = false) {
    const video = videos[index],
      camera = descriptor.cameras[index],
      ordinal = presented
        ? nearestFrame(camera.video_pts_ns, stamp)
        : containingFrame(camera.video_pts_ns, stamp);
    if (disposed || failed || video.seeking || video.readyState < 2) return;
    if (
      presented &&
      Math.abs(camera.video_pts_ns[ordinal] - stamp * 1e9) > 111_112
    )
      return;
    if ((wanted !== null ? ordinal !== wanted : ordinal <= shown) || images[index].has(ordinal)) return;
    const canvas = document.createElement("canvas");
    [canvas.width, canvas.height] = camera.image_size;
    const context = canvas.getContext("2d");
    if (!context) {
      releaseImage(canvas);
      fail(new Error("无法读取预览画面"), "capture_canvas");
      return;
    }
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch (error) {
      releaseImage(canvas);
      fail(error, "capture_frame");
      return;
    }
    images[index].set(ordinal, canvas);
    pruneImages(index, wanted ?? shown);
    if (playing && !canAdvance(index)) video.pause();
    tryPresent();
  }
  function resume() {
    const advancing = videos.filter((_, i) => canAdvance(i));
    if (
      disposed ||
      failed ||
      !playing ||
      busy ||
      resuming ||
      advancing.every((video) => !video.paused) ||
      advancing.some((video) => video.readyState < 3 || video.seeking)
    )
      return;
    resuming = true;
    const active = revision, startedAt = performance.now();
    diagnose("playback.resume_started", { frame, revision: active });
    void Promise.all(advancing.map((video) => video.play()))
      .then(
        () => { if (!disposed) diagnose("playback.resume_finished", {
          revision: active, durationMs: Math.round(performance.now() - startedAt), outcome: "playing",
        }); },
        (error) => {
          if (disposed) return;
          const aborted = (error as Error).name === "AbortError";
          diagnose("playback.resume_finished", {
            revision: active, durationMs: Math.round(performance.now() - startedAt), outcome: aborted ? "aborted" : "failed",
          });
          if (!aborted) fail(error, "video_play");
        },
      )
      .finally(() => {
        resuming = false;
        if (
          !disposed &&
          playing &&
          !busy &&
          videos.some((video, i) => video.paused && canAdvance(i))
        )
          queueMicrotask(resume);
      });
  }
  function tryPresent() {
    if (disposed || failed || (!playing && wanted === null && shown >= 0)) return;
    if (wanted === shown && videos.some((video) => video.readyState < (playing ? 3 : 2) || video.seeking))
      return;
    const candidates =
      wanted !== null
        ? [wanted]
        : [...images[0].keys()]
            .filter((value) => value > shown)
            .sort((a, b) => b - a);
    const next = candidates.find((index) =>
      images.every((cache) => cache.has(index)),
    );
    if (next === undefined) return;
    const body = bodyAt(next);
    if (!body) {
      if (!busy) diagnose("playback.waiting_for_body", { frame: next, revision, mode, workerFirst: workerJob?.first ?? null });
      busy = true;
      pendingFrame = next;
      pause();
      notify();
      void fetchFrames(next);
      return;
    }
    const previous = shown, previousImages = shownImages;
    frame = next;
    shown = next;
    wanted = null;
    pendingFrame = null;
    busy = false;
    stalledAt = performance.now();
    shownImages = images.map((cache) => cache.get(next)!);
    output.present(body, next, shownImages);
    const renderMs = Math.round(performance.now() - stalledAt);
    previousImages.forEach((image, i) => {
      if (image !== shownImages[i] && images[i].get(previous) !== image) releaseImage(image);
    });
    images.forEach((_, i) => pruneImages(i, shown));
    if (seekStartedAt !== null || previous === -1) {
      diagnose(seekStartedAt === null ? "playback.first_frame" : "playback.seek_completed", {
        durationMs: Math.round(performance.now() - (seekStartedAt ?? playbackStartedAt)), renderMs, ...snapshot(),
      });
      seekStartedAt = null;
    } else if (renderMs >= 50) {
      diagnose("playback.slow_render", { frame, revision, renderMs });
    }
    notify();
    if (next >= descriptor.frames - 1) {
      playing = false;
      pause();
      notify();
      return;
    }
    pruneBodies();
    prefetch();
    resume();
  }
  function seek(index: number, reason: "control" | "watchdog" | "restart" | "display_mode" | "buffering" = "control") {
    if (disposed || failed) return;
    revision++;
    pendingFrame = null;
    pause();
    wanted = Math.min(descriptor.frames - 1, Math.max(0, index));
    frame = wanted;
    busy = true;
    const target = wanted;
    seekStartedAt = performance.now();
    diagnose("playback.seek_started", { reason, target, ...snapshot() });
    pruneBodies();
    videos.forEach((video, i) => {
      for (const [ordinal, image] of images[i])
        if (ordinal !== target) dropCachedImage(i, ordinal, image);
      if (target === shown) images[i].set(target, shownImages[i]);
      video.currentTime = seekSeconds(
        descriptor.cameras[i].video_pts_ns,
        target,
        video.duration,
      );
    });
    notify();
    if (!bodyAt(target)) void fetchFrames(target);
    tryPresent();
  }
  videos.forEach((video, i) => {
    if (!video.requestVideoFrameCallback) {
      fail(new Error("浏览器不支持视频帧回调，请使用新版 Chrome 或 Edge"), "video_frame_callback");
      return;
    }
    const next = (_time: number, metadata: VideoFrameCallbackMetadata) => {
      if (disposed) return;
      mediaTimeMs[i] = Math.round(metadata.mediaTime * 1000);
      capture(i, metadata.mediaTime, true);
      callbacks[i] = video.requestVideoFrameCallback(next);
    };
    callbacks[i] = video.requestVideoFrameCallback(next);
    const error = () => {
      diagnose("playback.video_error", { view: descriptor.cameras[i].view_id, code: video.error?.code ?? null });
      fail(new Error("代理视频加载失败，请重试"), "video_decode");
    };
    const waiting = () => {
      diagnose("playback.video_waiting", {
        view: descriptor.cameras[i].view_id, readyState: video.readyState, wanted, frame, revision,
      });
      if (disposed || !playing || wanted !== null) return;
      if (shown >= 0) seek(shown, "buffering");
    };
    // Paused seeks can coalesce without a presented-frame callback. seeked/canplay
    // guarantee that the current decoded image is available at currentTime.
    const ready = () => {
      if (!disposed) {
        if (wanted !== null && !video.seeking && video.readyState >= 2)
          capture(i, video.currentTime);
        tryPresent();
        resume();
      }
    };
    video.addEventListener("error", error);
    video.addEventListener("waiting", waiting);
    video.addEventListener("canplay", ready);
    video.addEventListener("seeked", ready);
    listeners.push(() => {
      video.removeEventListener("error", error);
      video.removeEventListener("waiting", waiting);
      video.removeEventListener("canplay", ready);
      video.removeEventListener("seeked", ready);
    });
    video.load();
  });
  diagnose("playback.started", { frames: descriptor.frames, ...snapshot() });
  const watchdog = setInterval(() => {
    if (disposed || failed || (!playing && !busy)) return;
    const now = performance.now(), elapsed = now - (seekStartedAt ?? stalledAt);
    if (elapsed > 1500 && now - lastStallLogAt >= 1500) {
      lastStallLogAt = now;
      diagnose("playback.no_progress", { elapsedMs: Math.round(elapsed), ...snapshot() });
    }
    if (playing && !busy && !workerJob && wanted === null && elapsed > 1500) {
      stalledAt = now;
      seek(Math.min(frame + 1, descriptor.frames - 1), "watchdog");
    }
  }, 500);
  void fetchFrames(0);
  notify();
  return {
    seek,
    setMode(next: DisplayMode) {
      if (disposed || failed || next === mode) return;
      mode = next;
      diagnose("playback.display_mode", { frame, mode });
      seek(frame, "display_mode");
    },
    pause() {
      playing = false;
      diagnose("playback.paused", { frame, revision });
      pause();
      releaseAhead();
      if (wanted === null && shown >= 0) busy = false;
      notify();
    },
    toggle() {
      if (disposed || failed) return;
      playing = !playing;
      diagnose("playback.play_command", { playing, frame, revision });
      if (playing && frame === descriptor.frames - 1) seek(0, "restart");
      if (!playing) { pause(); releaseAhead(); if (wanted === null && shown >= 0) busy = false; }
      else {
        tryPresent();
        prefetch();
        resume();
      }
      notify();
    },
    dispose() {
      disposed = true;
      const before = snapshot();
      clearInterval(watchdog);
      pause();
      videos.forEach((video, i) => {
        listeners[i]?.();
        if (callbacks[i]) video.cancelVideoFrameCallback(callbacks[i]);
        video.removeAttribute("src");
        video.load();
        video.remove();
      });
      images.forEach((cache, i) => {
        for (const [ordinal, image] of cache) dropCachedImage(i, ordinal, image);
      });
      shownImages.forEach(releaseImage);
      shownImages = [];
      bodyFrames.clear();
      diagnose("playback.disposed", {
        releasedCanvasBytes: before.canvasBytes, releasedJointFrames: before.jointCacheFrames,
        releasedBodyBytes: before.bodyCacheBytes,
      });
    },
  };
}
