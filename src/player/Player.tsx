import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { LoaderCircle, Maximize2, Minimize2, Pause, Play } from "lucide-react";
import type { Recording } from "./package";
import type { RecordDiagnostic } from "../lib/diagnostics";
import type { DisplayMode } from "./displayMode";
import { createScene } from "./scene";
import { startPlayback } from "./playback";
import { clock } from "./time";
import { viewColumns } from "./layout";
import "./Player.css";

const MESH_VIEW = "SMPL-X";

export default function Player({
  recording,
  mode,
  diagnose,
  onError,
  suspended,
}: {
  recording: Recording;
  mode: DisplayMode;
  diagnose: RecordDiagnostic;
  onError: (recording: Recording, message: string) => void;
  suspended: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    nodes = useRef<HTMLDivElement>(null),
    tiles = useRef(new Map<string, HTMLDivElement>()),
    meshViewport = useRef<HTMLDivElement>(null),
    sceneHandle = useRef<ReturnType<typeof createScene> | null>(null),
    modeRef = useRef(mode);
  const playback = useRef<ReturnType<typeof startPlayback> | null>(null);
  const [focusedView, setFocused] = useState<string | null>(null);
  const focused = mode === "skeleton" && focusedView === MESH_VIEW ? null : focusedView;
  if (focusedView !== focused) setFocused(focused);
  const focusButtons = useRef(new Map<string, HTMLButtonElement>());
  const [state, setState] = useState({
    frame: 0,
    busy: true,
    playing: false,
    ready: false,
  });
  useLayoutEffect(() => {
    modeRef.current = mode;
    sceneHandle.current?.setMeshViewport(meshViewport.current);
    playback.current?.setMode(mode);
  }, [mode]);
  useEffect(() => {
    if (!host.current || !nodes.current) return;
    let scene: ReturnType<typeof createScene> | undefined;
    try {
      scene = createScene(
        host.current,
        recording.cameras.map(camera => tiles.current.get(camera.view_id)!),
        recording,
        diagnose,
      );
      sceneHandle.current = scene;
      scene.setMeshViewport(meshViewport.current);
      playback.current = startPlayback(recording, nodes.current, {
        present: scene.present,
        update: (frame, busy, playing) =>
          setState((previous) => ({
            frame,
            busy,
            playing,
            ready: previous.ready || !busy,
          })),
        error: (message) => onError(recording, message),
        diagnose,
      }, modeRef.current);
    } catch (error) {
      diagnose("player.initialization_failed");
      onError(recording, "相机预览初始化失败：" + (error as Error).message);
    }
    return () => {
      playback.current?.dispose();
      playback.current = null;
      scene?.dispose();
      sceneHandle.current = null;
    };
  }, [recording, onError, diagnose]);
  useEffect(() => {
    if (suspended) playback.current?.pause();
  }, [suspended]);
  useEffect(() => {
    if (focused === null) return;
    function restore(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      setFocused(null);
      focusButtons.current.get(focused!)?.focus();
    }
    window.addEventListener("keydown", restore);
    return () => window.removeEventListener("keydown", restore);
  }, [focused]);
  const views = mode === "mesh" ? [null, ...recording.cameras] : recording.cameras,
    columns = focused === null ? viewColumns(views.length) : 1;
  const gridStyle = {
    "--columns": columns,
    "--medium-columns": Math.min(3, columns),
    "--compact-columns": Math.min(2, columns),
  } as CSSProperties;
  return (
    <section
      className="player"
      aria-label="录制同步播放器"
      data-frame={state.frame}
      data-busy={state.busy}
      data-playing={state.playing}
      data-focused-view={focused ?? ""}
      data-display-mode={mode}
    >
      <div className="player-grid" ref={host} style={gridStyle}>
        {views.map(camera => {
          const name = camera?.view_id ?? MESH_VIEW;
          return (
            <div className="player-tile" key={name} hidden={focused !== null && focused !== name}>
              <div className="tile-heading">
                <span title={camera?.camera_id}>{name}</span>
                <div className="tile-actions">
                  {camera && !camera.source_observed[state.frame] && <span>缺帧</span>}
                  <button
                    ref={button => {
                      if (button) focusButtons.current.set(name, button);
                      else focusButtons.current.delete(name);
                    }}
                    className="icon-button"
                    aria-label={focused === name ? "恢复宫格" : `放大 ${name}`}
                    title={focused === name ? "恢复宫格 (Esc)" : `放大 ${name}`}
                    aria-pressed={focused === name}
                    onClick={() => setFocused(focused === name ? null : name)}
                  >
                    {focused === name ? <Minimize2 /> : <Maximize2 />}
                  </button>
                </div>
              </div>
              <div
                ref={node => {
                  if (!camera) meshViewport.current = node;
                  else if (node) tiles.current.set(name, node);
                  else tiles.current.delete(name);
                }}
                className="player-viewport"
                onDoubleClick={() => {
                  setFocused(focused === name ? null : name);
                  focusButtons.current.get(name)?.focus();
                }}
              />
            </div>
          );
        })}
        {state.busy && (
          <div className="player-buffer" role="status">
            <LoaderCircle className="spin" />
            正在缓冲…
          </div>
        )}
      </div>
      <div className="player-controls">
        <button
          className="icon-button"
          disabled={!state.ready}
          aria-label={state.playing ? "暂停" : "播放"}
          title={state.playing ? "暂停" : "播放"}
          onClick={() => playback.current?.toggle()}
        >
          {state.playing ? <Pause /> : <Play />}
        </button>
        <span>{clock(recording.relative_timestamps_ns[state.frame])}</span>
        <input
          aria-label="播放位置"
          disabled={!state.ready}
          type="range"
          min={0}
          max={recording.frames - 1}
          value={state.frame}
          onChange={(event) =>
            playback.current?.seek(Number(event.target.value))
          }
        />
        <span>{clock(recording.relative_timestamps_ns.at(-1)!)}</span>
        {!recording.body_observed[state.frame] && <span>缺少人体观测</span>}
      </div>
      <div className="player-videos" ref={nodes} aria-hidden="true" />
    </section>
  );
}
