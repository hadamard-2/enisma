import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { Home } from "@/components/home/home";
import { EditorRoute } from "@/components/editor/editor";
import { ThemeProvider } from "@/lib/theme";
import "./App.css";

function App() {
  return (
    <ThemeProvider>
      <HashRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/project/:id" element={<EditorRoute />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </ThemeProvider>
  );
}

export default App;
