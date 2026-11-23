import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  Box,
  Download,
  FileArchive,
  FolderOpen,
  LoaderCircle,
  Waypoints,
  X,
} from "lucide-react";
import { openArchive, type RecordingArchive } from "./lib/archive";
import { createDiagnostics } from "./lib/diagnostics";
import { prepareRecording, type Recording } from "./player/package";
import type { DisplayMode } from "./player/displayMode";
const loadPlayer = () => import("./player/Player");
const Player = lazy(loadPlayer);
import "./App.css";

export default function App() {
  const [diagnostics] = useState(createDiagnostics);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("mesh");
  const [recording, setRecording] = useState<Recording | null>(null),
    [generation, setGeneration] = useState(0);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(""),
    [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    pending = useRef<AbortController | null>(null),
    current = useRef<Recording | null>(null),
    dragDepth = useRef(0);
  const toggleDisplayMode = useCallback(() => {
    setDisplayMode(mode => mode === "mesh" ? "skeleton" : "mesh");
  }, []);
  useEffect(() => {
    function changeDisplayMode(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.isComposing || !event.shiftKey
        || event.altKey || event.ctrlKey || event.metaKey || event.key.toLowerCase() !== "i") return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable
        || target.matches("textarea, select, input:not([type=range])"))) return;
      event.preventDefault();
      toggleDisplayMode();
    }
    window.addEventListener("keydown", changeDisplayMode);
    return () => window.removeEventListener("keydown", changeDisplayMode);
  }, [toggleDisplayMode]);
  useEffect(
    () => () => {
      pending.current?.abort();
      const previous = current.current;
      current.current = null;
      previous?.dispose();
    },
    [],
  );
  const fail = useCallback((source: Recording, message: string) => {
    if (current.current !== source) return;
    diagnostics.record("app.playback_failed");
    current.current = null;
    source.dispose();
    setRecording(null);
    setError(`预览失败：${message}。请重新打开录制包。`);
  }, [diagnostics]);
  async function open(file: File) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const started = performance.now();
    let stage = "archive";
    diagnostics.record("app.open_started", { zipBytes: file.size });
    setLoading("正在读取录制包…");
    setError("");
    setDragging(false);
    dragDepth.current = 0;
    let archive: RecordingArchive | undefined;
    try {
      archive = await openArchive(file, controller.signal, () => {});
      diagnostics.record("app.archive_read", { files: archive.assets.length });
      stage = "player_module";
      try {
        await loadPlayer();
      } catch (cause) {
        throw new Error("播放器资源加载失败，请刷新页面后重新打开 ZIP", { cause });
      }
      controller.signal.throwIfAborted();
      stage = "recording";
      const next = await prepareRecording(
        archive,
        controller.signal,
        (text) => {
          if (!controller.signal.aborted) {
            diagnostics.record("app.prepare_stage", { stage: text });
            setLoading(text);
          }
        },
      );
      if (controller.signal.aborted) {
        next.dispose();
        return;
      }
      archive.close();
      diagnostics.record("app.open_completed", {
        frames: next.frames, cameras: next.cameras.length,
        durationMs: Math.round(performance.now() - started),
      });
      const previous = current.current;
      current.current = next;
      previous?.dispose();
      setRecording(next);
      setGeneration((value) => value + 1);
    } catch (error) {
      archive?.close();
      diagnostics.record("app.open_finished", {
        stage, outcome: controller.signal.aborted ? "aborted" : "failed",
        durationMs: Math.round(performance.now() - started),
      });
      if (!controller.signal.aborted)
        setError(`无法打开录制包：${(error as Error).message}`);
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setLoading("");
    }
  }
  function close() {
    diagnostics.record("app.recording_closed");
    pending.current?.abort();
    const previous = current.current;
    current.current = null;
    previous?.dispose();
    setRecording(null);
    setLoading("");
    setError("");
  }
  return (
    <main
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        if (--dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const files = event.dataTransfer.files;
        if (files.length !== 1) {
          setError("请一次打开一个 ZIP 录制包");
          return;
        }
        void open(files[0]);
      }}
    >
      <header className="app-header">
        <a className="brand" href="./" aria-label="SynaExo Viewer 首页">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
          <span>
            SynaExo <b>Viewer</b>
          </span>
        </a>
        <div className="header-actions">
          {recording && (
            <button
              onClick={toggleDisplayMode}
              aria-label={displayMode === "mesh" ? "切换为关键点" : "切换为 Mesh"}
              title={displayMode === "mesh" ? "切换为关键点 (Shift+I)" : "切换为 Mesh (Shift+I)"}
              aria-keyshortcuts="Shift+I"
            >
              {displayMode === "mesh" ? <Waypoints /> : <Box />}
              {displayMode === "mesh" ? "关键点" : "Mesh"}
            </button>
          )}
          <button className="icon-button" aria-label="下载日志" title="下载日志" onClick={diagnostics.download}>
            <Download />
          </button>
          {recording && (
            <button
              className="icon-button"
              aria-label="关闭录制包"
              title="关闭录制包"
              onClick={close}
            >
              <X />
            </button>
          )}
          <button onClick={() => input.current?.click()}>
            <FolderOpen />
            打开 ZIP
          </button>
        </div>
      </header>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void open(file);
          event.target.value = "";
        }}
      />
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button
            className="icon-button"
            title="关闭提示"
            aria-label="关闭提示"
            onClick={() => setError("")}
          >
            <X />
          </button>
        </div>
      )}
      {recording ? (
        <Suspense
          fallback={
            <div className="view-loading" role="status">
              <LoaderCircle className="spin" />
              正在准备视图…
            </div>
          }
        >
          <Player
            key={generation}
            recording={recording}
            mode={displayMode}
            diagnose={diagnostics.record}
            onError={fail}
            suspended={!!loading}
          />
        </Suspense>
      ) : (
        <section className="empty-workspace">
          <div className="drop-zone">
            <div className="archive-symbol">
              <FileArchive />
            </div>
            <h1>打开录制包</h1>
            <p>拖入 ZIP，或选择文件</p>
            <button className="primary" onClick={() => input.current?.click()}>
              <FolderOpen />
              选择 ZIP
            </button>
            <span className="local-note">本地读取，不上传文件</span>
          </div>
        </section>
      )}
      {loading && (
        <div className="import-overlay" role="status">
          <LoaderCircle className="spin" />
          <span>{loading}</span>
          <button
            onClick={() => {
              pending.current?.abort();
              setLoading("");
            }}
          >
            <ArrowLeft />
            取消
          </button>
        </div>
      )}
      {dragging && (
        <div className="drag-overlay">
          <FileArchive />
          <span>松开以打开录制包</span>
        </div>
      )}
    </main>
  );
}
