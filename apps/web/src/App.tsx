import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { CoverageGapsPage } from "./pages/CoverageGapsPage";
import { RepositoryDetailPage } from "./pages/RepositoryDetailPage";
import { RepositoryFormPage } from "./pages/RepositoryFormPage";
import { RepositoryListPage } from "./pages/RepositoryListPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { RunHistoryPage } from "./pages/RunHistoryPage";
import { SliceDetailPage } from "./pages/SliceDetailPage";
import { SlicesPage } from "./pages/SlicesPage";

export function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<RepositoryListPage />} />
          <Route path="/repositories" element={<RepositoryListPage />} />
          <Route path="/activity" element={<RunHistoryPage />} />
          <Route path="/repositories/new" element={<RepositoryFormPage />} />
          <Route path="/repositories/:repositoryId" element={<RepositoryDetailPage />} />
          <Route path="/repositories/:repositoryId/edit" element={<RepositoryFormPage />} />
          <Route path="/repositories/:repositoryId/coverage" element={<CoverageGapsPage />} />
          <Route path="/repositories/:repositoryId/slices" element={<SlicesPage />} />
          <Route path="/repositories/:repositoryId/slices/:sliceName" element={<SliceDetailPage />} />
          <Route path="/runs/:runId" element={<RunDetailPage />} />
          <Route path="*" element={<div className="page"><div className="empty-state panel"><h1>Page not found</h1><LinkBack /></div></div>} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

function LinkBack() {
  return <a href="/">Return to repositories</a>;
}
