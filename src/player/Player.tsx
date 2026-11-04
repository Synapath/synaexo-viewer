import { useEffect, useRef, useState, type CSSProperties } from "react";
import { LoaderCircle, Maximize2, Minimize2, Pause, Play } from "lucide-react";
import type { Recording } from "./package";
import { createScene } from "./scene";
import { startPlayback } from "./playback";
import { clock } from "./time";
import { viewColumns } from "./layout";
import "./Player.css";

export default function Player({
  recording,
  onError,
  suspended,
}: {
  recording: Recording;
  onError: (recording: Recording, message: string) => void;
  suspended: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    nodes = useRef<HTMLDivElement>(null),
    tiles = useRef<(HTMLDivElement | null)[]>([]);
  const playback = useRef<ReturnType<typeof startPlayback> | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const focusButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const [state, setState] = useState({
    frame: 0,
    busy: true,
    playing: false,
    ready: false,
  });
  useEffect(() => {
    if (!host.current || !nodes.current) return;
    let scene: ReturnType<typeof createScene> | undefined;
    try {
      scene = createScene(
        host.current,
        tiles.current.filter((node): node is HTMLDivElement => !!node),
        recording,
      );
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
      });
    } catch (error) {
      onError(recording, "三维预览初始化失败：" + (error as Error).message);
    }
    return () => {
      playback.current?.dispose();
      playback.current = null;
      scene?.dispose();
    };
  }, [recording, onError]);
  useEffect(() => {
    if (suspended) playback.current?.pause();
  }, [suspended]);
  useEffect(() => {
    if (focused === null) return;
    function restore(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setFocused(null);
      focusButtons.current[focused!]?.focus();
    }
    window.addEventListener("keydown", restore);
    return () => window.removeEventListener("keydown", restore);
  }, [focused]);
  const names = ["SMPL-X", ...recording.cameras.map((c) => c.view_id)],
    columns = focused === null ? viewColumns(names.length) : 1;
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
      data-focused-view={focused === null ? "" : names[focused]}
    >
      <div className="player-grid" ref={host} style={gridStyle}>
        {names.map((name, i) => (
          <div
            className="player-tile"
            key={name}
            hidden={focused !== null && focused !== i}
          >
            <div className="tile-heading">
              <span title={i ? recording.cameras[i - 1].camera_id : undefined}>
                {name}
              </span>
              <div className="tile-actions">
                {i > 0 &&
                  !recording.cameras[i - 1].source_observed[state.frame] && (
                    <span>缺帧</span>
                  )}
                <button
                  ref={(button) => { focusButtons.current[i] = button; }}
                  className="icon-button"
                  aria-label={focused === i ? "恢复宫格" : `放大 ${name}`}
                  title={focused === i ? "恢复宫格 (Esc)" : `放大 ${name}`}
                  aria-pressed={focused === i}
                  onClick={() => setFocused(focused === i ? null : i)}
                >
                  {focused === i ? <Minimize2 /> : <Maximize2 />}
                </button>
              </div>
            </div>
            <div
              ref={(node) => {
                tiles.current[i] = node;
              }}
              className="player-viewport"
              onDoubleClick={() => {
                setFocused(focused === i ? null : i);
                focusButtons.current[i]?.focus();
              }}
            />
          </div>
        ))}
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
