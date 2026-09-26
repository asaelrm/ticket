import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [appName, setAppName] = useState('Ticket');
  const queryClient = useQueryClient();

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
    // Antes de fijar la identidad nueva: las claves de caché no incluyen el
    // usuario, así que sin purgar, un empleado que abriera sesión en el mismo
    // navegador donde antes hubo un administrador vería los tickets, usuarios y
    // registros de auditoría que ese otro usuario tenía cacheados.
    queryClient.clear();
    await api.post('/api/auth/login', { account, password, remember });
    // Se consulta /me para garantizar que el usuario incluye sus permisos.
    const data = await api.get('/api/auth/me');
    setUser(data.user);
    return data.user;
  }, [queryClient]);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      // La sesión puede haber expirado; cerrar sesión local igualmente.
    }
    // La caché pertenece a la sesión que se está cerrando. Sin esto, el
    // siguiente usuario de la máquina hereda sus datos mientras React Query va
    // revalidando, y también si la revalidación falla con 401/403, porque las
    // pantallas muestran el dato cacheado y solo añaden el aviso de error.
    queryClient.clear();
    setUser(null);
  }, [queryClient]);

  const value = { user, setUser, loading, login, logout, appName, setAppName };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

export function can(user, permission) {
  return !!user && user.permissions?.includes(permission);
}