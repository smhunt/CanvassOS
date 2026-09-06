import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="page page--narrow">
      <div className="card">
        <h1>Page not found</h1>
        <p className="muted">That address does not exist in MC Canvass.</p>
        <Link to="/map" className="btn btn--primary">
          Back to the map
        </Link>
      </div>
    </div>
  );
}
