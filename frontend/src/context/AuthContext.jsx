import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [appName, setAppName] = useState('Ticket');

  useEffect(() => {
    let active = true;
    api
      .get('/api/auth/me')
      .then((data) => {
        if (active) setUser(data.user);
      })
      .catch(() => {
        if (active) setUser(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    api
      .get('/api/settings')
      .then((data) => {
        if (active && data.data?.app_name) setAppName(data.data.app_name);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [user]);

  const login = useCallback(async (account, password, remember) => {
    // Antes de fijar la identidad nueva: las claves de cachÃ© no incluyen el
    // usuario, asÃ­ que sin purgar, un empleado que abriera sesiÃ³n en el mismo
    // navegador donde antes hubo un administrador verÃ­a los tickets, usuarios y
    // registros de auditorÃ­a que ese otro usuario tenÃ­a cacheados.
    await api.post('/api/auth/login', { account, password, remember });
    // Se consulta /me para garantizar que el usuario incluye sus permisos.
    const data = await api.get('/api/auth/me');
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      // La sesiÃ³n puede haber expirado; cerrar sesiÃ³n local igualmente.
    }
    // La cachÃ© pertenece a la sesiÃ³n que se estÃ¡ cerrando. Sin esto, el
    // siguiente usuario de la mÃ¡quina hereda sus datos mientras React Query va
    // revalidando, y tambiÃ©n si la revalidaciÃ³n falla con 401/403, porque las
    // pantallas muestran el dato cacheado y solo aÃ±aden el aviso de error.
    setUser(null);
  }, []);

  const value = { user, setUser, loading, login, logout, appName, setAppName };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

export function can(user, permission) {
  return !!user && user.permissions?.includes(permission);
}