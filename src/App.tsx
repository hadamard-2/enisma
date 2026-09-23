import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { Home } from "@/components/home/home";
import { EditorRoute } from "@/components/editor/editor";
import { ThemeProvider } from "@/lib/theme";
import { AppCommandsProvider } from "@/lib/app-commands";
import { TitleBar } from "@/components/chrome/title-bar";
import { ExportProvider } from "@/components/export/export-provider";
import "./App.css";

function App() {
  return (
    <ThemeProvider>
      <HashRouter>
        <AppCommandsProvider>
          <ExportProvider>
            <TitleBar />
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/project/:id" element={<EditorRoute />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </ExportProvider>
        </AppCommandsProvider>
      </HashRouter>
    </ThemeProvider>
  );
}

export default App;
