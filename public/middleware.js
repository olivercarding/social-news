// middleware.js
export const config = {
  // Only run this middleware on the root page (your dashboard)
  matcher: ['/'],
};

export default function middleware(request) {
  // Get the username and password from Vercel Environment Variables
  // If these aren't set, default to "admin" / "password" (CHANGE THIS IN PROD!)
  const user = process.env.DASHBOARD_USER || 'admin';
  const pass = process.env.DASHBOARD_PASSWORD || 'password';

  // Check the "Authorization" header sent by the browser
  const basicAuth = request.headers.get('authorization');

  if (basicAuth) {
    const authValue = basicAuth.split(' ')[1];
    // Decode the Base64 username:password
    const [providedUser, providedPass] = atob(authValue).split(':');

    if (providedUser === user && providedPass === pass) {
      // If credentials match, let them through
      return;
    }
  }

  // If no auth or wrong password, return 401 Unauthorized
  // This triggers the browser's built-in login popup
  return new Response('Auth required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Secure Dashboard"',
    },
  });
}