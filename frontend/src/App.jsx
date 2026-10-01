import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { Activity, BookOpen, LogOut, Settings as Cog, Sparkles } from 'lucide-react';
import { getToken, setToken, setUnauthorizedHandler } from './lib/api.js';
import { useLive } from './lib/useLive.js';
import Login from './pages/Login.jsx';
import Live from './pages/Live.jsx';
import Journal from './pages/Journal.jsx';
import Settings from './pages/Settings.jsx';
import Reviews from './pages/Reviews.jsx';
import TopBar from './components/TopBar.jsx';

export default function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setAuthed(false);
    });
  }, []);
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;
  return <Shell onLogout={() => (setToken(null), setAuthed(false))} />;
}

function Shell({ onLogout }) {
  const live = useLive();
  return (
    <div className="shell">
      <TopBar state={live.state} connected={live.connected} />
      <nav className="tabs">
        <NavLink to="/" end><Activity size={14} /> Live desk</NavLink>
        <NavLink to="/journal"><BookOpen size={14} /> Journal</NavLink>
        <NavLink to="/reviews"><Sparkles size={14} /> AI review</NavLink>
        <NavLink to="/settings"><Cog size={14} /> Strategy &amp; risk</NavLink>
        <span className="grow" />
        <button className="linkbtn" onClick={onLogout}><LogOut size={14} /> Sign out</button>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Live {...live} />} />
          <Route path="/journal" element={<Journal mode={live.state?.mode} />} />
          <Route path="/reviews" element={<Reviews state={live.state} />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
