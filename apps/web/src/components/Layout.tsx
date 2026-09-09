import { type PropsWithChildren, useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { api } from "../api";
import { Icon } from "./Icon";

export function Layout({ children }: PropsWithChildren) {
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [connection, setConnection] = useState<"checking" | "online" | "offline">("checking");
  const section = pathname === "/" ? "Overview" : pathname === "/activity" || pathname.startsWith("/runs/") ? "Run history" : "Repositories";
  useEffect(() => { setMenuOpen(false); window.scrollTo(0, 0); }, [pathname]);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const resize = () => { setMobile(query.matches); if (!query.matches) setMenuOpen(false); };
    query.addEventListener("change", resize);
    return () => query.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    if (sidebarRef.current) sidebarRef.current.inert = mobile && !menuOpen;
    if (!mobile || !menuOpen) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = sidebarRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
    const first = focusable?.[0];
    const last = focusable?.[focusable.length - 1];
    first?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
      if (event.key === "Tab" && event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (event.key === "Tab" && !event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = overflow; window.removeEventListener("keydown", keydown); menuButtonRef.current?.focus(); };
  }, [mobile, menuOpen]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        await api("/api/health", { signal: AbortSignal.timeout(8_000) });
        if (!cancelled) setConnection("online");
      } catch { if (!cancelled) setConnection("offline"); }
      finally { if (!cancelled) timer = setTimeout(check, 30_000); }
    };
    void check();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);
  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">Skip to content</a>
      {menuOpen && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
      <aside ref={sidebarRef} className={`sidebar ${menuOpen ? "is-open" : ""}`} id="workspace-navigation" aria-hidden={mobile && !menuOpen}>
        <button className="icon-button sidebar-close" aria-label="Close navigation" onClick={() => setMenuOpen(false)}><Icon name="close" size={16} /></button>
        <Link to="/" className="brand" aria-label="QA Buddy home"><span className="brand-mark"><Icon name="layers" size={23} /></span><strong>qa<span>buddy</span><i /></strong></Link>
        <div className="workspace-switcher"><span className="workspace-avatar"><Icon name="terminal" size={19} /></span><div><strong>My workspace</strong><small>Local environment</small></div></div>
        <span className="nav-label">Workspace</span>
        <nav aria-label="Primary navigation" onClick={() => setMenuOpen(false)}>
          <NavLink to="/" end><Icon name="grid" />Overview</NavLink>
          <NavLink to="/repositories"><Icon name="repository" />Repositories</NavLink>
          <NavLink to="/activity" className={pathname.startsWith("/runs/") ? "active" : undefined}><Icon name="clock" />Run history</NavLink>
        </nav>
        <div className="sidebar-bottom"><div className="sidebar-note"><span className="note-icon"><Icon name="shield" size={19} /></span><strong>Your code. Your machine.</strong><p>Isolated test runs, with results that stay in your workspace.</p></div><div className="workspace-profile"><span className="profile-avatar">L</span><div><strong>Local workspace</strong><small>Made for your next green build</small></div></div></div>
      </aside>
      <div className="app-content">
        <header className="topbar"><div className="topbar-location"><button ref={menuButtonRef} type="button" className="icon-button mobile-menu" aria-label={menuOpen ? "Close navigation" : "Open navigation"} aria-expanded={menuOpen} aria-controls="workspace-navigation" onClick={() => setMenuOpen(!menuOpen)}><Icon name={menuOpen ? "close" : "menu"} /></button><span>Workspace</span><Icon name="chevron" size={13} /><strong>{section}</strong></div><div className="topbar-right"><span className={`connection connection-${connection}`} role="status"><i />{connection === "online" ? "Local server connected" : connection === "offline" ? "Server disconnected" : "Connecting to server"}</span><span className="topbar-divider" /><span className="profile-avatar small" title="Local workspace">L</span></div></header>
        <main id="main-content" tabIndex={-1}>{children}</main>
        <footer><span>QA Buddy <span className="footer-dot">·</span> A little more confidence in every commit.</span><span><Icon name="terminal" size={13} /> Local workspace</span></footer>
      </div>
    </div>
  );
}
