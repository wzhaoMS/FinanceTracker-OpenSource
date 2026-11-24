import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './fonts.css';
import './styles.css';
import './modes.css';
import './components/benefits/benefits.css';
import './components/amazon/amazon.css';
import './components/costco/costco.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
