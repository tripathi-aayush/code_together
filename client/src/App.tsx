import { BrowserRouter, Routes, Route } from 'react-router-dom';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<div style={{ color: '#fff', fontFamily: 'sans-serif', padding: 40 }}>🚀 CodeTogether — Phase 0 scaffold running!</div>} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
