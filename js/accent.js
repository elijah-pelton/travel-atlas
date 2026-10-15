// Applies the saved highlight color before the page paints (loaded synchronously in <head>).
try { var a = localStorage.getItem('travel-atlas:accent'); if (a && a !== 'amber') document.documentElement.setAttribute('data-accent', a); } catch (e) {}
