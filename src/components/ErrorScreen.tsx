import { Component, type ReactNode } from 'react'

interface State {
  error: Error | null
}

/**
 * Last resort for a crash anywhere in the app: a message and Reload instead of a blank screen.
 * Reloading is safe mid-game: state comes back from the server.
 */
export class ErrorScreen extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="error-screen">
        <h1>Something went wrong</h1>
        <p className="muted">Reload to carry on. Your game is safe on the server.</p>
        <button className="wide" onClick={() => location.reload()}>
          Reload
        </button>
        <p className="muted small">{this.state.error.message}</p>
      </main>
    )
  }
}
