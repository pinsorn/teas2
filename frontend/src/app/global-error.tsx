'use client';

// Replaces the root layout when it fails, so providers and messages are NOT available here:
// the only file in the app where literal Thai UI text is allowed (keep it in step with state.errorTitle / state.retry in th.json).
export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="th">
      <body style={{ fontFamily: 'sans-serif', padding: '1.5rem' }}>
        <h1 style={{ fontSize: '1.25rem' }}>โหลดข้อมูลไม่สำเร็จ</h1>
        <p>ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้ง</p>
        <button type="button" onClick={retry}>ลองใหม่</button>
      </body>
    </html>
  );
}
