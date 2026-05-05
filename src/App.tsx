import { Home } from "@/components/home/home";
import { ThemeProvider } from "@/lib/theme";
import "./App.css";

function App() {
  return (
    <ThemeProvider>
      <Home />
    </ThemeProvider>
  );
}

export default App;
