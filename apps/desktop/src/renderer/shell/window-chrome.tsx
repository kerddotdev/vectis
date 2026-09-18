import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const storageKey = "vectis.sidebar";
const WindowChrome = createContext<{
  collapsed: boolean;
  fullscreen: boolean;
  toggleSidebar: () => void;
} | null>(null);

export function WindowChromeProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(storageKey) === "collapsed",
  );
  const [fullscreen, setFullscreen] = useState(false);
  function toggleSidebar() {
    setCollapsed((value) => {
      localStorage.setItem(storageKey, value ? "open" : "collapsed");
      return !value;
    });
  }
  useEffect(
    () =>
      window.vectis?.onWindowEvent((event) => {
        if (event === "toggle-sidebar") toggleSidebar();
        else setFullscreen(event === "fullscreen-enter");
      }),
    [],
  );
  return <WindowChrome value={{ collapsed, fullscreen, toggleSidebar }}>{children}</WindowChrome>;
}

export function useWindowChrome() {
  const chrome = useContext(WindowChrome);
  if (!chrome) throw new Error("Missing window chrome.");
  return chrome;
}
