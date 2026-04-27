import React, { useEffect } from 'react';

/**
 * Lazy-loaded CodeMirror editor pane.
 * Dynamically imports the heavy EditorPane (564KB) to keep initial load fast.
 */
export function LazyEditorPane({ 
  onContentChange, 
  onScrollContainerReady,
}: { 
  onContentChange: (content: string) => void;
  onScrollContainerReady?: (el: HTMLDivElement | null) => void;
}) {
  const [Comp, setComp] = React.useState<React.ComponentType<{
    onContentChange: (c: string) => void;
    onScrollContainerReady?: (el: HTMLDivElement | null) => void;
  }> | null>(null);

  useEffect(() => {
    import('./EditorPane').then(m => setComp(() => m.default));
  }, []);

  if (!Comp) {
    return (
      <div style={{ 
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#999', fontSize: 13
      }}>
        Loading editor…
      </div>
    );
  }

  return <Comp onContentChange={onContentChange} onScrollContainerReady={onScrollContainerReady} />;
}
