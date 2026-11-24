import {afterEach,expect,test,vi} from "vitest";
import {startPlayback} from "./playback";
import type {Recording} from "./package";

afterEach(() => {vi.unstubAllGlobals();vi.useRealTimers();});

function setup(computeMs = 0, cameraCount = 2, imageSize = [64,32]) {
  vi.useFakeTimers();
  class Video extends EventTarget {
    muted = false; playsInline = false; preload = ""; src = "";
    paused = true; readyState = 4; networkState = 0; seeking = false; ended = false;
    currentTime = 0; duration = 2;
    callback?: VideoFrameRequestCallback;
    play() {this.paused = false;return Promise.resolve();}
    pause() {this.paused = true;}
    load() {}
    requestVideoFrameCallback(callback: VideoFrameRequestCallback) {this.callback = callback;return 1;}
    cancelVideoFrameCallback() {this.callback = undefined;}
    removeAttribute() {this.src = "";}
    remove() {}
  }
  const videos: Video[] = [],canvases: {width:number;height:number}[] = [];
  vi.stubGlobal("document", {
    visibilityState: "visible",
    createElement(tag: string) {
      if (tag === "video") {const video = new Video();videos.push(video);return video;}
      const canvas = {width:0,height:0,getContext:() => ({drawImage(){}})};
      canvases.push(canvas);return canvas;
    },
  });
  const frames = vi.fn(async (_first:number,count:number,mesh:boolean) => {
    if (computeMs) await new Promise(resolve => setTimeout(resolve,computeMs));
    return {joints:new Float32Array(count*55*3),
      vertices:mesh?new Float32Array(count*10475*3):undefined,computeMs};
  });
  const descriptor = {
    frames:60,relative_timestamps_ns:Array.from({length:60},(_,i) => Math.round(i*1e9/30)),
    cameras:Array.from({length:cameraCount},(_,i) => ({view_id:"EXO0"+i,url:"/video"+i,image_size:imageSize,
      video_pts_ns:Array.from({length:60},(_,i) => Math.round(i*1e9/30))})),
    engine:{frames},
  } as unknown as Recording;
  const output = {present:vi.fn(),update:vi.fn(),error:vi.fn(),diagnose:vi.fn()};
  const player = startPlayback(descriptor,{append(){}} as unknown as HTMLElement,output,"mesh");
  const decode = (camera:number,frame:number) => videos[camera].callback!(0,{mediaTime:frame/30} as VideoFrameCallbackMetadata);
  const present = (frame:number) => videos.forEach((_,i) => decode(i,frame));
  return {player,frames,output,videos,canvases,decode,present};
}

test("playing fills a consecutive prefetch window without waiting for more decoded video frames",async () => {
  const fixture = setup();
  fixture.present(0);await vi.advanceTimersByTimeAsync(1);
  expect(fixture.frames.mock.calls.map(([first]) => first)).toEqual([0]);
  fixture.player.toggle();await vi.advanceTimersByTimeAsync(1);
  expect(fixture.frames.mock.calls.map(([first]) => first)).toEqual([0,8,16,24]);
  expect(fixture.output.present.mock.calls.at(-1)?.[1]).toBe(0);
  fixture.player.dispose();
});

test("pause releases ahead canvases and repeated seeks reuse the displayed body",async () => {
  const fixture = setup();
  fixture.present(0);await vi.advanceTimersByTimeAsync(1);fixture.player.toggle();
  fixture.decode(0,1);
  const ahead = fixture.canvases.at(-1)!;
  const calls = fixture.frames.mock.calls.length;
  fixture.player.pause();
  expect(ahead.width).toBe(0);
  fixture.player.seek(0);await vi.advanceTimersByTimeAsync(1);
  expect(fixture.frames.mock.calls.length).toBe(calls);
  expect(fixture.output.present.mock.calls.at(-1)?.[1]).toBe(0);
  fixture.player.dispose();
  expect(fixture.canvases.every(canvas => canvas.width===0&&canvas.height===0)).toBe(true);
  expect(fixture.videos.every(video => !video.src&&!video.callback)).toBe(true);
});

test("seven views cross slow Worker batches without repeatedly pausing the videos",async () => {
  const fixture = setup(250,7);
  fixture.present(0);await vi.advanceTimersByTimeAsync(251);fixture.player.toggle();
  fixture.output.update.mockClear();
  for (let frame=1;frame<30;frame++) {
    await vi.advanceTimersByTimeAsync(33);
    fixture.present(frame);
  }
  expect(fixture.output.present.mock.calls.at(-1)?.[1]).toBe(29);
  expect(fixture.output.update.mock.calls.some(([,busy]) => busy)).toBe(false);
  fixture.player.dispose();
  await vi.advanceTimersByTimeAsync(300);
  expect(fixture.output.error).not.toHaveBeenCalled();
});

test("large views release old backing stores as their shared byte budget fills",async () => {
  const fixture = setup(0,2,[2048,1024]);
  fixture.present(0);await vi.advanceTimersByTimeAsync(1);fixture.player.toggle();
  for (let frame=1;frame<20;frame++) fixture.decode(0,frame);
  expect(fixture.canvases.filter(canvas => canvas.width>0).length).toBeLessThanOrEqual(6);
  fixture.player.dispose();
  expect(fixture.canvases.every(canvas => canvas.width===0&&canvas.height===0)).toBe(true);
});

test("a decoder at its cache limit waits for slower cameras without losing their next common frame",async () => {
  const fixture = setup(0,2,[2048,1024]);
  fixture.present(0);await vi.advanceTimersByTimeAsync(1);fixture.player.toggle();
  for (let frame=1;frame<=4;frame++) fixture.decode(0,frame);
  expect(fixture.videos[0].paused).toBe(true);
  expect(fixture.videos[1].paused).toBe(false);
  fixture.decode(1,1);await vi.advanceTimersByTimeAsync(1);
  expect(fixture.output.present.mock.calls.at(-1)?.[1]).toBe(1);
  expect(fixture.videos.every(video => !video.paused)).toBe(true);
  fixture.player.dispose();
});

test("pausing during a slow body batch preserves its next aligned picture for resume",async () => {
  const fixture = setup(250);
  fixture.present(0);await vi.advanceTimersByTimeAsync(251);fixture.player.toggle();
  fixture.present(9);fixture.player.pause();
  expect(fixture.output.update.mock.calls.at(-1)).toEqual([0,false,false]);
  await vi.advanceTimersByTimeAsync(251);
  fixture.player.toggle();await vi.advanceTimersByTimeAsync(1);
  expect(fixture.output.present.mock.calls.at(-1)?.[1]).toBe(9);
  fixture.player.dispose();
});

test("a failed prefetch stops further Worker requests",async () => {
  const fixture = setup();
  fixture.present(0);await vi.advanceTimersByTimeAsync(1);
  fixture.frames.mockRejectedValueOnce(new Error("Synthetic Worker failure"));
  fixture.player.toggle();await vi.advanceTimersByTimeAsync(1);
  const count = fixture.frames.mock.calls.length;
  fixture.player.toggle();fixture.player.seek(20);fixture.present(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(fixture.frames).toHaveBeenCalledTimes(count);
  expect(fixture.output.error).toHaveBeenCalledTimes(1);
  fixture.player.dispose();
});
