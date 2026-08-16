import Link from 'next/link';

export default function Home() {
  return (
    <main style={{ maxWidth: '46ch', margin: '0 auto', padding: '2rem 1.25rem' }}>
      <h1>Learn App</h1>
      <p>Welcome to the learning platform.</p>
      <p>
        <Link href="/lessons/2-installation">Start reading: Installing MCP Servers</Link>
      </p>
    </main>
  );
}
