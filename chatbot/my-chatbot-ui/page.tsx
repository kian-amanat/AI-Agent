import Sidebar from '../Sidebar';

export default function Page() {
  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <Sidebar />
      <div style={{ flex: 1, padding: '24px' }}>
        {/* Chatbot UI content goes here */}
      </div>
    </div>
  );
}