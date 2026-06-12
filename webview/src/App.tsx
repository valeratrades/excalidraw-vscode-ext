import { useEffect, useState, useRef } from "react";
import {
  Excalidraw,
  loadLibraryFromBlob,
  serializeLibraryAsJSON,
  THEME,
} from "@excalidraw/excalidraw";

import "@excalidraw/excalidraw/index.css";

import "./styles.css";
import {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import { vscode } from "./vscode.ts";

function detectTheme() {
  switch (document.body.className) {
    case "vscode-dark":
      return THEME.DARK;
    case "vscode-light":
      return THEME.LIGHT;
    default:
      return THEME.LIGHT;
  }
}

// Brush defaults asserted on a freshly-loaded scene. These mirror the standalone
// browser script: Code font, half opacity, thin stroke. Only filled in when the
// saved file didn't already specify them, so per-file choices win.
const ITEM_DEFAULTS = {
  currentItemFontFamily: 3,
  currentItemOpacity: 50,
  currentItemStrokeWidth: 1,
} as const;

const VIEW_BG_COLOR = "#ffffff";

type Api = ExcalidrawImperativeAPI;

function inTextInput(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

// Step the canvas zoom by a multiplicative factor, clamped to Excalidraw's own
// 0.1..30 bounds, anchored on the viewport center (matches the toolbar zoom).
function stepZoom(api: Api, factor: number) {
  const st = api.getAppState();
  const cur = st.zoom?.value || 1;
  const next = Math.min(30, Math.max(0.1, cur * factor));
  const cx = st.width / 2;
  const cy = st.height / 2;
  // screen = (scene + scroll) * zoom, so scene = screen/zoom - scroll. Keep the
  // scene point under the center fixed as the zoom value changes.
  const sceneX = cx / cur - st.scrollX;
  const sceneY = cy / cur - st.scrollY;
  api.updateScene({
    appState: {
      zoom: { value: next as AppState["zoom"]["value"] },
      scrollX: cx / next - sceneX,
      scrollY: cy / next - sceneY,
    },
  });
}

// Pan the viewport by a screen-space delta; convert to scroll (scene) units so
// the visual distance is constant regardless of zoom.
function panBy(api: Api, dxScreen: number, dyScreen: number) {
  const st = api.getAppState();
  const z = st.zoom?.value || 1;
  api.updateScene({
    appState: { scrollX: st.scrollX - dxScreen / z, scrollY: st.scrollY - dyScreen / z },
  });
}

const PAN_KEYS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

// Scale the selected elements by `factor` about their common bounding-box center,
// so the group stays put while growing/shrinking. Geometry, font size, and
// relative line/arrow/freedraw points all scale together.
function scaleSelection(api: Api, factor: number) {
  const sel = api.getAppState().selectedElementIds || {};
  const all = api.getSceneElements();
  const picked = all.filter((el) => sel[el.id] && !el.isDeleted);
  if (!picked.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  picked.forEach((el) => {
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + el.width);
    maxY = Math.max(maxY, el.y + el.height);
  });
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const picks: Record<string, boolean> = {};
  picked.forEach((el) => (picks[el.id] = true));
  const next = all.map((el) => {
    if (!picks[el.id]) return el;
    const u: Record<string, unknown> = {
      x: cx + (el.x - cx) * factor,
      y: cy + (el.y - cy) * factor,
      width: el.width * factor,
      height: el.height * factor,
    };
    if (typeof (el as any).fontSize === "number") u.fontSize = (el as any).fontSize * factor;
    if ((el as any).points)
      u.points = (el as any).points.map((p: [number, number]) => [p[0] * factor, p[1] * factor]);
    return { ...el, ...u };
  });
  api.updateScene({ elements: next as any });
}

// Click the Nth button of the Stroke color row in the left panel (1-5 are the
// quick-pick swatches, 6 is the active-color button that opens the full picker).
// Position-based: whatever color sits there is what gets picked. The Stroke
// section is the one whose active-color button is aria-labelled "Stroke".
function clickStrokeSwatch(n: number): boolean {
  const actives = document.querySelectorAll(".color-picker__button.active-color");
  let strokeActive: Element | null = null;
  for (let i = 0; i < actives.length; i++) {
    const lbl = (actives[i].getAttribute("aria-label") || "").toLowerCase();
    if (lbl.indexOf("stroke") !== -1) {
      strokeActive = actives[i];
      break;
    }
  }
  if (!strokeActive && actives.length) strokeActive = actives[0];
  if (!strokeActive) return false;
  if (n === 6) {
    (strokeActive as HTMLElement).click();
    return true;
  }
  const picks = strokeActive.parentElement?.querySelector(".color-picker__top-picks");
  if (!picks) return false;
  const btn = picks.querySelectorAll("button")[n - 1] as HTMLElement | undefined;
  if (!btn) return false;
  btn.click();
  return true;
}

function useTheme(initialThemeConfig: string) {
  const [themeConfig, setThemeConfig] = useState(initialThemeConfig);
  const getExcalidrawTheme = () => {
    switch (themeConfig) {
      case "light":
        return THEME.LIGHT;
      case "dark":
        return THEME.DARK;
      case "auto":
        return detectTheme();
    }
  };
  const [theme, setTheme] = useState(getExcalidrawTheme());
  const updateTheme = () => {
    setTheme(getExcalidrawTheme());
  };

  useEffect(updateTheme, [themeConfig]);

  // Alt+R flips light/dark at runtime. Resolve `auto` to whatever it currently
  // shows, then pin the opposite as an explicit config so the toggle sticks.
  const toggleTheme = () => {
    const current = getExcalidrawTheme();
    setThemeConfig(current === THEME.DARK ? "light" : "dark");
  };

  useEffect(() => {
    if (themeConfig !== "auto") return;
    const observer = new MutationObserver(() => {
      updateTheme();
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => {
      observer.disconnect();
    };
  }, [themeConfig]);

  return { theme, setThemeConfig, toggleTheme };
}

export default function App(props: {
  initialData?: ExcalidrawInitialDataState;
  name: string;
  theme: string;
  langCode: string;
  viewModeEnabled: boolean;
  libraryItems?: LibraryItems;
  imageParams: {
    exportBackground: boolean;
    exportWithDarkMode: boolean;
    exportScale: 1 | 2 | 3;
  };
  dirty: boolean;
  onChange: (
    elements: readonly any[],
    appState: Partial<AppState>,
    files?: BinaryFiles
  ) => void;
}) {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI>();
  const libraryItemsRef = useRef(props.libraryItems);
  const { theme, setThemeConfig, toggleTheme } = useTheme(props.theme);
  const [imageParams, setImageParams] = useState(props.imageParams);
  const [langCode, setLangCode] = useState(props.langCode);

  useEffect(() => {
    if (!props.dirty) {
      return;
    }
    if (props.initialData) {
      const { elements, appState, files } = props.initialData;
      props.onChange(elements || [], appState || {}, files);
    } else {
      props.onChange([], { viewBackgroundColor: "#ffffff" }, {});
    }
  }, []);

  useEffect(() => {
    const listener = async (e: any) => {
      try {
        const message = e.data;
        switch (message.type) {
          case "library-change": {
            const blob = new Blob([message.library], {
              type: "application/json",
            });
            const libraryItems = await loadLibraryFromBlob(blob);
            if (
              JSON.stringify(libraryItems) ==
              JSON.stringify(libraryItemsRef.current)
            ) {
              return;
            }
            libraryItemsRef.current = libraryItems;
            excalidrawAPI?.updateLibrary({
              libraryItems,
              merge: message.merge,
              openLibraryMenu: !message.merge,
            });
            break;
          }
          case "theme-change": {
            setThemeConfig(message.theme);
            break;
          }
          case "language-change": {
            setLangCode(message.langCode);
            break;
          }
          case "image-params-change": {
            setImageParams(message.imageParams);
          }
        }
      } catch (e) {
        vscode.postMessage({
          type: "error",
          content: (e as Error).message,
        });
      }
    };
    window.addEventListener("message", listener);

    return () => {
      window.removeEventListener("message", listener);
    };
  }, [excalidrawAPI]);

  // Force the canvas background after mount: Excalidraw's restore() mangles
  // initialData.appState, so re-assert via the public API which nothing overrides.
  useEffect(() => {
    if (!excalidrawAPI) return;
    excalidrawAPI.updateScene({ appState: { viewBackgroundColor: VIEW_BG_COLOR } });
  }, [excalidrawAPI]);

  // Custom canvas keybindings ported from the standalone browser editor.
  useEffect(() => {
    const api = excalidrawAPI;
    if (!api) return;

    const onKeyDown = (e: KeyboardEvent) => {
      // Alt+R flips light/dark. Fires from anywhere, including mid text-edit.
      if (e.altKey && e.key === "r") {
        e.preventDefault();
        toggleTheme();
        return;
      }
      // Everything below is canvas-only: while editing text do nothing custom and
      // never preventDefault, so the keypress lands in the input normally.
      if (inTextInput(e.target)) return;

      // Shift +/- — grow/shrink the selection. Shift+= yields '+', Shift+- yields '_'.
      if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "+" || e.key === "_")) {
        e.preventDefault();
        scaleSelection(api, e.key === "_" ? 1 / 1.1 : 1.1);
        return;
      }
      // Ctrl+1..6 — pick the Nth button in the Stroke color row.
      if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key >= "1" && e.key <= "6") {
        if (clickStrokeSwatch(+e.key)) {
          e.preventDefault();
          return;
        }
      }
      if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "-" || e.key === "_")) {
        e.preventDefault();
        stepZoom(api, 1 / 1.1);
      } else if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        stepZoom(api, 1.1);
      } else if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "0" || e.key === ")")) {
        // Re-anchor content to the viewport center, preserving the zoom level.
        e.preventDefault();
        api.scrollToContent(undefined, { fitToContent: false });
      } else if (PAN_KEYS[e.key] && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Arrows pan only when nothing is selected, preserving native nudge.
        const sel = api.getAppState().selectedElementIds || {};
        if (Object.keys(sel).length) return;
        e.preventDefault();
        const step = e.shiftKey ? 320 : 80;
        const dir = PAN_KEYS[e.key];
        panBy(api, dir[0] * step, dir[1] * step);
      }
    };

    // Esc deselect lives in a CAPTURE-phase listener: Excalidraw's own document
    // keydown calls stopImmediatePropagation on Escape, so a bubble handler never
    // sees it. We don't preventDefault (Excalidraw still closes popups etc.); we
    // just force-clear the selection on the next macrotask so it sticks.
    const onEscCapture = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (inTextInput(e.target)) return;
      setTimeout(() => {
        const s = api.getAppState();
        if (
          Object.keys(s.selectedElementIds || {}).length ||
          Object.keys(s.selectedGroupIds || {}).length
        ) {
          api.updateScene({ appState: { selectedElementIds: {}, selectedGroupIds: {} } });
        }
      }, 0);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keydown", onEscCapture, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keydown", onEscCapture, true);
    };
  }, [excalidrawAPI, toggleTheme]);

  return (
    <div className="excalidraw-wrapper">
      <Excalidraw
        excalidrawAPI={(api) => setExcalidrawAPI(api)}
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
          },
        }}
        langCode={langCode}
        name={props.name}
        theme={theme}
        viewModeEnabled={props.viewModeEnabled}
        initialData={{
          ...props.initialData,
          appState: {
            ...ITEM_DEFAULTS,
            ...props.initialData?.appState,
            viewBackgroundColor: VIEW_BG_COLOR,
          },
          libraryItems: props.libraryItems,
          scrollToContent: true,
        }}
        libraryReturnUrl={"vscode://valeratrades.excalidraw-editor/importLib"}
        onChange={(elements, appState, files) =>
          props.onChange(
            elements,
            { ...appState, ...imageParams, exportEmbedScene: true },
            files
          )
        }
        onLinkOpen={(element, event) => {
          vscode.postMessage({
            type: "link-open",
            url: element.link,
          });
          event.preventDefault();
        }}
        onLibraryChange={(libraryItems) => {
          if (
            JSON.stringify(libraryItems) ==
            JSON.stringify(libraryItemsRef.current)
          ) {
            return;
          }
          libraryItemsRef.current = libraryItems;
          vscode.postMessage({
            type: "library-change",
            library: serializeLibraryAsJSON(libraryItems),
          });
        }}
      />
    </div>
  );
}
