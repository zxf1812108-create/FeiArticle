import {createRoot} from 'react-dom/client';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';
import '@fontsource/noto-sans-sc/600.css';
import '@fontsource/noto-sans-sc/700.css';
import App from './App.tsx';
import './index.css';
import { applyThemeMode, loadTheme } from './utils/storage';

applyThemeMode(loadTheme());

createRoot(document.getElementById('root')!).render(<App />);
