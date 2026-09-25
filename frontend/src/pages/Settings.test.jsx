import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Settings from './Settings';
import { api } from '../lib/api';
import { renderWithProviders } from '../test/utils';

const { authState } = vi.hoisted(() => ({
  authState: { setAppName: vi.fn() },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ setAppName: authState.setAppName }),
  can: (user, permission) => !!user?.permissions?.includes(permission),
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

const SETTINGS = {
  app_name: 'Ticket',
  company_name: 'Acme',
  ticket_prefix: 'TCK',
  footer_text: 'Soporte interno',
  sla_critical_hours: '4',
  sla_high_hours: '24',
  sla_medium_hours: '48',
  sla_low_hours: '72',
  resolution_categories: 'Configuración, Reparación',
  root_causes: 'Falla de hardware, Error de usuario',
  pending_reasons: 'Falta de repuesto',
  require_resolution_to_close: '1',
  notify_on_assign: '1',
  notify_on_comment: '0',
  notify_on_resolve: '1',
  enable_csat: '0',
  rule_unassigned_hours: '8',
  rule_unassigned_priority: 'HIGH',
  rule_critical_hours: '12',
};

const MAIL = {
  enabled: true,
  useSmtp: true,
  host: 'smtp.acme.com',
  port: 587,
  from: 'no-reply@acme.com',
  fromName: 'Acme',
  hasUser: true,
};

function setup(settings = SETTINGS, mail = MAIL, emails = []) {
  api.get.mockImplementation((url) => {
    if (url === '/api/settings') return Promise.resolve({ data: settings });
    if (url === '/api/settings/mail') return Promise.resolve({ data: mail });
    if (url === '/api/settings/emails') return Promise.resolve({ data: emails });
    return Promise.reject(new Error(`404 ${url}`));
  });
  api.patch.mockResolvedValue({ data: { ...settings, app_name: 'Ticket PRO' } });
}

function settingsCalls() {
  return api.get.mock.calls.filter(([u]) => u === '/api/settings').length;
}

function fieldFor(labelText, tag, scope = screen) {
  const label = scope.getByText(labelText, { selector: 'label' });
  return label.querySelector(tag) || label.closest('div').querySelector(tag);
}

beforeEach(() => {
  vi.resetAllMocks();
  setup();
});

describe('Settings', () => {
  it('muestra la pantalla de carga mientras trae la configuración', () => {
    api.get.mockImplementation((url) => (url === '/api/settings' ? new Promise(() => {}) : Promise.resolve({ data: {} })));

    renderWithProviders(<Settings />, { route: '/app/settings' });
    expect(screen.getByText('Cargando configuración…')).toBeInTheDocument();
  });

  it('carga la configuración y la muestra en el formulario', async () => {
    renderWithProviders(<Settings />, { route: '/app/settings' });

    expect(await screen.findByText('Configuración del sistema')).toBeInTheDocument();
    expect(fieldFor('Nombre del sistema', 'input')).toHaveValue('Ticket');
    expect(fieldFor('Nombre de la empresa', 'input')).toHaveValue('Acme');
    expect(fieldFor('Prefijo de tickets', 'input')).toHaveValue('TCK');
    expect(fieldFor('Texto del pie de página', 'input')).toHaveValue('Soporte interno');
    expect(fieldFor('Prioridad crítica', 'input')).toHaveValue(4);
    expect(fieldFor('Prioridad alta', 'input')).toHaveValue(24);
    expect(fieldFor('Prioridad media', 'input')).toHaveValue(48);
    expect(fieldFor('Prioridad baja', 'input')).toHaveValue(72);
    expect(api.get).toHaveBeenCalledWith('/api/settings');
  });

  it('convierte las listas separadas por comas en líneas', async () => {
    renderWithProviders(<Settings />, { route: '/app/settings' });

    expect(await screen.findByText('Configuración del sistema')).toBeInTheDocument();
    expect(fieldFor('Categorías de solución', 'textarea')).toHaveValue('Configuración\nReparación');
    expect(fieldFor('Causas raíz', 'textarea')).toHaveValue('Falla de hardware\nError de usuario');
    expect(fieldFor('Motivos de ticket pendiente', 'textarea')).toHaveValue('Falta de repuesto');
  });

  it('refleja los interruptores según los valores "1"/"0" del servidor', async () => {
    renderWithProviders(<Settings />, { route: '/app/settings' });

    expect(await screen.findByText('Configuración del sistema')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Exigir una resolución antes de cerrar/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Al asignar un ticket/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Cuando hay un comentario nuevo/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Al resolver un ticket/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Activar encuesta de satisfacción/ })).not.toBeChecked();
  });

  it('guarda los cambios y actualiza el nombre de la aplicación', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Settings />, { route: '/app/settings' });
    await screen.findByText('Configuración del sistema');

    const appName = fieldFor('Nombre del sistema', 'input');
    await user.clear(appName);
    await user.type(appName, 'Ticket PRO');
    await user.click(screen.getByRole('checkbox', { name: /Activar encuesta de satisfacción/ }));
    await user.click(screen.getByRole('button', { name: 'Guardar configuración' }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ app_name: 'Ticket PRO', enable_csat: '1' }))
    );
    expect(await screen.findByText('Configuración guardada correctamente.')).toBeInTheDocument();
    expect(authState.setAppName).toHaveBeenCalledWith('Ticket PRO');
  });

  it('envía las listas como arreglos y los booleanos como "1"/"0"', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Settings />, { route: '/app/settings' });
    await screen.findByText('Configuración del sistema');

    const categories = fieldFor('Categorías de solución', 'textarea');
    await user.clear(categories);
    await user.type(categories, 'Reemplazo\nInstalación');
    await user.click(screen.getByRole('checkbox', { name: /Exigir una resolución antes de cerrar/ }));
    await user.click(screen.getByRole('button', { name: 'Guardar configuración' }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        '/api/settings',
        expect.objectContaining({
          resolution_categories: ['Reemplazo', 'Instalación'],
          root_causes: ['Falla de hardware', 'Error de usuario'],
          pending_reasons: ['Falta de repuesto'],
          require_resolution_to_close: '0',
          notify_on_assign: '1',
          notify_on_comment: '0',
          notify_on_resolve: '1',
        })
      )
    );
  });

  it('guarda los tiempos de SLA y las reglas de escalación', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Settings />, { route: '/app/settings' });
    await screen.findByText('Configuración del sistema');

    const sla = fieldFor('Prioridad crítica', 'input');
    await user.clear(sla);
    await user.type(sla, '6');
    const unassigned = screen.getByRole('spinbutton', { name: /Escalar sin asignar después de/ });
    await user.clear(unassigned);
    await user.type(unassigned, '4');
    await user.selectOptions(screen.getByRole('combobox', { name: /Prioridad al escalar/ }), 'CRITICAL');
    await user.click(screen.getByRole('button', { name: 'Guardar configuración' }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        '/api/settings',
        expect.objectContaining({ sla_critical_hours: '6', rule_unassigned_hours: '4', rule_unassigned_priority: 'CRITICAL' })
      )
    );
  });

  it('muestra el error de la API y conserva los valores introducidos', async () => {
    api.patch.mockRejectedValueOnce(new Error('El prefijo de tickets debe tener entre 1 y 8 caracteres alfanuméricos'));

    const user = userEvent.setup();
    renderWithProviders(<Settings />, { route: '/app/settings' });
    await screen.findByText('Configuración del sistema');

    const appName = fieldFor('Nombre del sistema', 'input');
    await user.clear(appName);
    await user.type(appName, 'Ticket PRO');
    await user.click(screen.getByRole('button', { name: 'Guardar configuración' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('El prefijo de tickets debe tener entre 1 y 8 caracteres alfanuméricos');
    expect(appName).toHaveValue('Ticket PRO');
    expect(screen.getByRole('button', { name: 'Guardar configuración' })).toBeEnabled();
    expect(authState.setAppName).not.toHaveBeenCalled();
  });

  it('limpia el mensaje de éxito al volver a editar', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Settings />, { route: '/app/settings' });
    await screen.findByText('Configuración del sistema');

    await user.click(screen.getByRole('button', { name: 'Guardar configuración' }));
    expect(await screen.findByText('Configuración guardada correctamente.')).toBeInTheDocument();

    await user.type(fieldFor('Nombre de la empresa', 'input'), ' ');
    await waitFor(() => expect(screen.queryByText('Configuración guardada correctamente.')).not.toBeInTheDocument());
  });

  it('muestra el estado del SMTP activo', async () => {
    renderWithProviders(<Settings />, { route: '/app/settings' });

    expect(await screen.findByText('Correo SMTP activo')).toBeInTheDocument();
    expect(screen.getByText(/smtp\.acme\.com:587/)).toBeInTheDocument();
    expect(screen.getByText(/de Acme <no-reply@acme\.com>/)).toBeInTheDocument();
  });

  it('muestra el modo de desarrollo cuando no hay SMTP', async () => {
    setup(SETTINGS, { enabled: false, useSmtp: false, host: '', port: '', from: '', fromName: '', hasUser: false });

    renderWithProviders(<Settings />, { route: '/app/settings' });
    expect(await screen.findByText('Modo desarrollo')).toBeInTheDocument();
  });

  it('lista los correos recientes con su estado', async () => {
    setup(SETTINGS, MAIL, [
      { id: 1, to_email: 'ana@acme.com', subject: 'Ticket asignado', ticket_number: 'TCK-000001', status: 'smtp', created_at: '2026-09-20T10:00:00Z' },
      { id: 2, to_email: 'luis@acme.com', subject: 'Nuevo comentario', ticket_number: 'TCK-000002', status: 'dev', created_at: '2026-09-21T11:00:00Z' },
      { id: 3, to_email: 'error@acme.com', subject: 'Fallo de envío', ticket_number: null, status: 'error', created_at: '2026-09-22T12:00:00Z' },
    ]);

    renderWithProviders(<Settings />, { route: '/app/settings' });

    expect(await screen.findByText('Correos recientes')).toBeInTheDocument();
    expect(screen.getByText('ana@acme.com')).toBeInTheDocument();
    expect(screen.getByText('TCK-000001')).toBeInTheDocument();
    expect(screen.getByText('Enviado')).toBeInTheDocument();
    expect(screen.getByText('Dev')).toBeInTheDocument();
    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByText('últimos 3')).toBeInTheDocument();
  });

  it('avisa que todavía no se han enviado correos', async () => {
    renderWithProviders(<Settings />, { route: '/app/settings' });

    expect(await screen.findByText('Todavía no se han enviado correos.')).toBeInTheDocument();
  });

  it('no vuelve a consultar la configuración al guardar', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Settings />, { route: '/app/settings' });
    await screen.findByText('Configuración del sistema');

    const before = settingsCalls();
    await user.click(screen.getByRole('button', { name: 'Guardar configuración' }));
    await screen.findByText('Configuración guardada correctamente.');

    expect(settingsCalls()).toBe(before);
  });

  it('expone los campos de SLA y de escalación dentro del mismo formulario', async () => {
    renderWithProviders(<Settings />, { route: '/app/settings' });
    await screen.findByText('Configuración del sistema');

    const form = screen.getByRole('button', { name: 'Guardar configuración' }).closest('form');
    expect(within(form).getAllByRole('spinbutton').length).toBe(6);
    expect(within(form).getAllByRole('checkbox').length).toBe(5);
  });
});
