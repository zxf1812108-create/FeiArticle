import {createRoot} from 'react-dom/client';
import '@fontsource/pt-serif/latin-400.css';
import '@fontsource/pt-serif/latin-400-italic.css';
import '@fontsource/pt-serif/latin-700.css';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(<App />);
