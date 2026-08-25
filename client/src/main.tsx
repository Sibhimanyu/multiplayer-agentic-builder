import { createRoot } from 'react-dom/client';
import App from './App';
import './tokens.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root missing from index.html');
createRoot(el).render(<App />);
