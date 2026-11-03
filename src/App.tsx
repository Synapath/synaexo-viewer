import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  FileArchive,
  FileJson,
  File as FileIcon,
  FolderOpen,
  Film,
  Image,
  LoaderCircle,
  Search,
  X,
} from "lucide-react";
import {
  assetKind,
  fileSize,
  openArchive,
  type Asset,
  type RecordingArchive,
} from "./lib/archive";
import "./App.css";

const icons = {
  video: Film,
  image: Image,
  json: FileJson,
  parameters: FileArchive,
  file: FileIcon,
};

function AssetPreview({
  archive,
  asset,
}: {
  archive: RecordingArchive;
  asset: Asset;
}) {
  const [state, setState] = useState<{
    archive?: RecordingArchive;
    asset?: Asset;
    url?: string;
    json?: string;
    error?: string;
  }>({});
  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    void (async () => {
      try {
        if (asset.kind === "json") {
          const value = await archive.json(asset.path, controller.signal);
          if (!controller.signal.aborted)
            setState({ archive, asset, json: JSON.stringify(value, null, 2) });
        } else if (asset.kind === "video" || asset.kind === "image") {
          const blob = await archive.blob(asset.path, controller.signal);
          if (controller.signal.aborted) return;
          url = URL.createObjectURL(blob);
          setState({ archive, asset, url });
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setState({ archive, asset, error: (error as Error).message });
      }
    })();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [archive, asset]);
  const value = state.archive === archive && state.asset === asset ? state : {};
  if (value.error)
    return (
      <div className="preview-state" role="alert">
        {value.error}
      </div>
    );
  if (asset.kind === "parameters" || asset.kind === "file")
    return (
      <div className="preview-state">
        <FileArchive />
        <h2>{asset.kind === "parameters" ? "参数文件" : "文件"}</h2>
        <span>此文件暂不支持预览</span>
      </div>
    );
  if (value.json !== undefined)
    return <pre className="json-preview">{value.json}</pre>;
  if (!value.url)
    return (
      <div className="preview-state" role="status">
        <LoaderCircle className="spin" />
        <span>正在读取文件…</span>
      </div>
    );
  return asset.kind === "image" ? (
    <img
      className="image-preview"
      src={value.url}
      alt={asset.path}
      onError={() =>
        setState({ archive, asset, error: "图片无法解析，请检查文件是否完整" })
      }
    />
  ) : (
    <video
      key={value.url}
      src={value.url}
      controls
      playsInline
      preload="metadata"
      onError={() =>
        setState({
          archive,
          asset,
          error: "浏览器无法播放此视频，请核对编码或更换浏览器",
        })
      }
    />
  );
}

export default function App() {
  const [archive, setArchive] = useState<RecordingArchive | null>(null);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null),
    pending = useRef<AbortController | null>(null),
    current = useRef<RecordingArchive | null>(null),
    dragDepth = useRef(0);
  useEffect(
    () => () => {
      pending.current?.abort();
      current.current?.close();
    },
    [],
  );
  async function open(file: File) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(0);
    setError("");
    setDragging(false);
    dragDepth.current = 0;
    try {
      const next = await openArchive(file, controller.signal, (count) => {
        if (!controller.signal.aborted) setLoading(count);
      });
      if (controller.signal.aborted) {
        next.close();
        return;
      }
      current.current?.close();
      current.current = next;
      setArchive(next);
      setQuery("");
      setSelected(
        next.assets.find((asset) => asset.kind === "video") ??
          next.assets.find((asset) =>
            /(^|\/)manifest\.json$/.test(asset.path),
          ) ??
          next.assets[0],
      );
    } catch (error) {
      if (!controller.signal.aborted)
        setError(`无法打开录制包：${(error as Error).message}`);
    } finally {
      if (!controller.signal.aborted) setLoading(null);
    }
  }
  function close() {
    pending.current?.abort();
    setLoading(null);
    setSelected(null);
    setArchive(null);
    setQuery("");
    setError("");
    current.current?.close();
    current.current = null;
  }
  const normalizedQuery = query.toLocaleLowerCase();
  const visibleAssets =
    archive?.assets.filter((asset) =>
      asset.path.toLocaleLowerCase().includes(normalizedQuery),
    ) ?? [];
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
          {archive && (
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
      {!archive ? (
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
      ) : (
        <section className="workspace">
          <aside className="resource-panel">
            <div className="resource-heading">
              <h1 title={archive.name}>{archive.name}</h1>
              <span>{archive.assets.length} 个文件</span>
            </div>
            <label className="search">
              <Search />
              <input
                aria-label="搜索文件"
                placeholder="搜索文件…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button
                  className="icon-button"
                  aria-label="清空搜索"
                  title="清空搜索"
                  onClick={() => setQuery("")}
                >
                  <X />
                </button>
              )}
            </label>
            <div className="file-list">
              {visibleAssets.map((asset) => {
                const Icon = icons[assetKind(asset.path)];
                return (
                  <button
                    key={asset.path}
                    className="file-row"
                    aria-pressed={selected?.path === asset.path}
                    onClick={() => setSelected(asset)}
                  >
                    <Icon />
                    <span className="file-name" title={asset.path}>
                      {asset.path.split("/").at(-1)}
                      <small>
                        {asset.path.includes("/")
                          ? asset.path.slice(0, asset.path.lastIndexOf("/"))
                          : "根目录"}
                      </small>
                    </span>
                    <span className="file-size">{fileSize(asset.bytes)}</span>
                  </button>
                );
              })}
              {visibleAssets.length === 0 && (
                <div className="no-results">没有匹配的文件</div>
              )}
            </div>
          </aside>
          <div className="preview-panel">
            {selected && (
              <>
                <div className="preview-heading">
                  <span title={selected.path}>{selected.path}</span>
                  <span>{fileSize(selected.bytes)}</span>
                </div>
                <div className="preview-content">
                  <AssetPreview
                    key={selected.path}
                    archive={archive}
                    asset={selected}
                  />
                </div>
              </>
            )}
          </div>
        </section>
      )}
      {loading !== null && (
        <div className="import-overlay" role="status">
          <LoaderCircle className="spin" />
          <span>正在读取清单{loading ? ` · ${loading} 个文件` : "…"}</span>
          <button
            onClick={() => {
              pending.current?.abort();
              setLoading(null);
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
