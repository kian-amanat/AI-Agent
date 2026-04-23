import React from 'react';

const App = () => {
    return (
        <div className="flex items-center justify-center h-screen bg-gray-100">
            <div className="w-full max-w-sm p-8 bg-white rounded-lg shadow-md">
                <div className="flex items-center justify-center">
                    <img src="<logo_url>" alt="Smart Engineer Logo" className="h-10 mb-4" />
                </div>
                <h1 className="text-2xl font-bold mb-4 text-center">Welcome Back</h1>
                <form id="login_form">
                    <div className="mb-4">
                        <input type="email" placeholder="example@gmail.com" className="w-full p-3 border border-gray-300 rounded" />
                    </div>
                    <div className="mb-4">
                        <input type="password" placeholder="Password" className="w-full p-3 border border-gray-300 rounded" />
                    </div>
                    <button type="submit" className="w-full p-3 bg-blue-500 text-white rounded hover:bg-blue-600">Log In</button>
                </form>
            </div>
        </div>
    );
};

export default App;