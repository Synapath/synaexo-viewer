import { containingFrame, nearestFrame, seekSeconds } from "./time";
import type { Recording } from "./package";

type Output = {
  present: (
    vertices: Float32Array,
    index: number,
    images: HTMLCanvasElement[],
  ) => void;
  update: (frame: number, busy: boolean, playing: boolean) => void;
  error: (message: string) => void;
};

export function startPlayback(
  descriptor: Recording,
  host: HTMLElement,
  output: Output,
) {
  const n = 10475 * 3;
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
    vertices = new Map<number, Float32Array>();
  let shownImages: HTMLCanvasElement[] = [];
  const callbacks: number[] = [],
    listeners: Array<() => void> = [],
    latest: Array<{ index: number; image: HTMLCanvasElement } | undefined> = [];
  let disposed = false,
    playing = false,
    frame = 0,
    shown = -1,
    wanted: number | null = 0,
    revision = 0,
    loading = false,
    busy = true,
    resuming = false,
    stalledAt = performance.now();
  const pause = () => videos.forEach((video) => video.pause());
  const notify = () => output.update(frame, busy, playing);
  const fail = (error: unknown) => {
    if (!disposed) {
      playing = false;
      pause();
      notify();
      output.error(error instanceof Error ? error.message : String(error));
    }
  };
  async function fetchFrames(first: number) {
    if (loading || disposed) return;
    const count = Math.min(8, descriptor.frames - first);
    if (count < 1) return;
    loading = true;
    const active = revision;
    try {
      const data = await descriptor.engine.frames(first, count);
      if (disposed || active !== revision) return;
      if (data.length !== count * n || !data.every(Number.isFinite))
        throw new Error("人体帧与当前时间不一致");
      for (let i = 0; i < count; i++)
        vertices.set(first + i, data.subarray(i * n, (i + 1) * n));
      for (const index of vertices.keys())
        if (index < frame - 2 || index > frame + 24) vertices.delete(index);
    } catch (error) {
      if (active === revision) fail(error);
    } finally {
      loading = false;
      if (!disposed) tryPresent();
    }
  }
  function capture(index: number, stamp: number, presented = false) {
    const video = videos[index],
      camera = descriptor.cameras[index],
      ordinal = presented
        ? nearestFrame(camera.video_pts_ns, stamp)
        : containingFrame(camera.video_pts_ns, stamp);
    if (
      presented &&
      Math.abs(camera.video_pts_ns[ordinal] - stamp * 1e9) > 111_112
    )
      return;
    const canvas = document.createElement("canvas");
    [canvas.width, canvas.height] = camera.image_size;
    const context = canvas.getContext("2d");
    if (!context) {
      fail(new Error("无法读取预览画面"));
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    images[index].set(ordinal, canvas);
    latest[index] = { index: ordinal, image: canvas };
    for (const value of images[index].keys())
      if (images[index].size > 12 || value < (wanted ?? shown) - 1)
        images[index].delete(value);
    tryPresent();
  }
  function resume() {
    if (
      disposed ||
      !playing ||
      busy ||
      resuming ||
      videos.every((video) => !video.paused) ||
      videos.some((video) => video.readyState < 3 || video.seeking)
    )
      return;
    resuming = true;
    void Promise.all(videos.map((video) => video.play()))
      .catch((error) => {
        if ((error as Error).name !== "AbortError") fail(error);
      })
      .finally(() => {
        resuming = false;
        if (
          !disposed &&
          playing &&
          !busy &&
          videos.some((video) => video.paused)
        )
          queueMicrotask(resume);
      });
  }
  function tryPresent() {
    if (disposed || (!playing && wanted === null && shown >= 0)) return;
    if (wanted === shown && videos.some((video) => video.readyState < 3))
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
    if (!vertices.has(next)) {
      busy = true;
      pause();
      notify();
      void fetchFrames(next);
      return;
    }
    frame = next;
    shown = next;
    wanted = null;
    busy = false;
    stalledAt = performance.now();
    shownImages = images.map((cache) => cache.get(next)!);
    output.present(vertices.get(next)!, next, shownImages);
    notify();
    if (next >= descriptor.frames - 1) {
      playing = false;
      pause();
      notify();
      return;
    }
    const upcoming = Math.max(next, ...vertices.keys()) + 1;
    if (upcoming < descriptor.frames && upcoming - next <= 16 && !loading)
      void fetchFrames(upcoming);
    resume();
  }
  function seek(index: number) {
    if (disposed) return;
    revision++;
    pause();
    wanted = Math.min(descriptor.frames - 1, Math.max(0, index));
    frame = wanted;
    busy = true;
    const target = wanted;
    vertices.clear();
    videos.forEach((video, i) => {
      const cached =
        images[i].get(target) ||
        (latest[i]?.index === target ? latest[i]!.image : undefined);
      images[i].clear();
      if (cached) images[i].set(target, cached);
      video.currentTime = seekSeconds(
        descriptor.cameras[i].video_pts_ns,
        target,
        video.duration,
      );
    });
    notify();
    void fetchFrames(target);
    tryPresent();
  }
  videos.forEach((video, i) => {
    if (!video.requestVideoFrameCallback) {
      fail(new Error("浏览器不支持视频帧回调，请使用新版 Chrome 或 Edge"));
      return;
    }
    const next = (_time: number, metadata: VideoFrameCallbackMetadata) => {
      if (disposed) return;
      capture(i, metadata.mediaTime, true);
      callbacks[i] = video.requestVideoFrameCallback(next);
    };
    callbacks[i] = video.requestVideoFrameCallback(next);
    const error = () => fail(new Error("代理视频加载失败，请重试"));
    const waiting = () => {
      if (disposed || !playing || wanted !== null) return;
      busy = true;
      pause();
      if (shown >= 0) {
        wanted = shown;
        images.forEach((cache, index) => cache.set(shown, shownImages[index]));
      }
      notify();
      tryPresent();
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
  const watchdog = setInterval(() => {
    if (
      !disposed &&
      playing &&
      !busy &&
      !loading &&
      wanted === null &&
      performance.now() - stalledAt > 1500
    ) {
      stalledAt = performance.now();
      seek(Math.min(frame + 1, descriptor.frames - 1));
    }
  }, 500);
  void fetchFrames(0);
  notify();
  return {
    seek,
    pause() {
      playing = false;
      pause();
      notify();
    },
    toggle() {
      if (disposed) return;
      playing = !playing;
      if (playing && frame === descriptor.frames - 1) seek(0);
      if (!playing) pause();
      else {
        tryPresent();
        resume();
      }
      notify();
    },
    dispose() {
      disposed = true;
      clearInterval(watchdog);
      pause();
      videos.forEach((video, i) => {
        listeners[i]?.();
        if (callbacks[i]) video.cancelVideoFrameCallback(callbacks[i]);
        video.removeAttribute("src");
        video.load();
        video.remove();
      });
      images.forEach((cache) => cache.clear());
      vertices.clear();
    },
  };
}
