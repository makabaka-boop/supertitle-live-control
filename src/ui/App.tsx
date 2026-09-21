import { useEffect, useState } from 'react';
import { EditorPage } from './EditorPage';
import { StagePage } from './StagePage';
import { ProjectionPage } from './ProjectionPage';

export type Route = 'editor' | 'stage' | 'projection';

function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  if (h === 'stage') return 'stage';
  if (h === 'projection') return 'projection';
  return 'editor';
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div className="app-shell">
      <nav className="top-nav">
        <span className="brand">歌剧舞台字幕台</span>
        <a
          href="#/editor"
          className={route === 'editor' ? 'nav-link active' : 'nav-link'}
        >
          节目单编辑
        </a>
        <a
          href="#/stage"
          className={route === 'stage' ? 'nav-link active' : 'nav-link'}
        >
          开演控制台
        </a>
        <a
          href="#/projection"
          className={route === 'projection' ? 'nav-link active' : 'nav-link'}
        >
          投影画面
        </a>
        <span className="offline-tag">本地运行 · 不联网</span>
      </nav>
      {route === 'editor' && <EditorPage />}
      {route === 'stage' && <StagePage />}
      {route === 'projection' && <ProjectionPage />}
    </div>
  );
}
