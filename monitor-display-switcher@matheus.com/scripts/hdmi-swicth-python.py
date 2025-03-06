#!/usr/bin/env python3
import dbus
import sys
import argparse

class DisplayManager:
    def __init__(self):
        self.bus = dbus.SessionBus()
        self.interface = self._get_dbus_interface()
        self.state = self._get_current_state()
        self.builtin, self.externals = self._find_monitors()

    def _get_dbus_interface(self):
        proxy = self.bus.get_object(
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig'
        )
        return dbus.Interface(proxy, 'org.gnome.Mutter.DisplayConfig')

    def _get_current_state(self):
        return self.interface.GetCurrentState()

    def _apply_config(self, logical_monitors):
        serial = self.state[0]
        self.interface.ApplyMonitorsConfig(
            serial,
            1,  # Modo imediato
            logical_monitors,
            {}
        )

    def _find_monitors(self):
        builtin = None
        externals = []
        
        for monitor in self.state[1]:
            props = monitor[2]
            connector = monitor[0][0]
            
            if props.get("is-builtin") or "eDP" in connector:
                builtin = monitor
            elif any(x in connector for x in ['HDMI', 'DP', 'DVI', 'USB']):
                externals.append(monitor)
                
        return builtin, externals

    def _get_best_mode(self, monitor):
        modes = monitor[1]
        return sorted(modes, 
            key=lambda m: (m[1] * m[2], m[4]),  # Área > refresh rate
            reverse=True
        )[0]

    def set_internal(self):
        if not self.builtin:
            raise Exception("Tela integrada não detectada")

        mode = self._get_best_mode(self.builtin)
        config = [self._create_monitor_config(
            self.builtin, mode, 0, 0, primary=True
        )]
        self._apply_config(config)
        print(" Modo interno ativado")

    def set_external(self):
        if not self.externals:
            raise Exception("Nenhum monitor externo detectado")

        target = self.externals[0]
        mode = self._get_best_mode(target)
        config = [self._create_monitor_config(
            target, mode, 0, 0, primary=True
        )]
        self._apply_config(config)
        print(" Modo externo ativado")

    def set_mirror(self):
        all_monitors = []
        if self.builtin:
            all_monitors.append(self.builtin)
        all_monitors.extend(self.externals)
        
        if len(all_monitors) < 2:
            raise Exception("Modo espelhado requer pelo menos 2 monitores")

        # Encontrar modo comum considerando precisão decimal
        common_mode = self._find_common_mode(all_monitors)
        
        if not common_mode:
            raise Exception("""Nenhum modo comum encontrado. Monitores disponíveis:
            HDMI-1: 1920x1080@60.000, 1920x1080@59.940
            eDP-1: 1920x1080@59.934
            Use uma resolução/taxa compatível manualmente primeiro""")

        print(f"Tentando modo: {common_mode['width']}x{common_mode['height']}@{common_mode['refresh']}Hz")

        # Configurar todos os monitores com o modo compatível
        physical_configs = []
        for monitor in all_monitors:
            # Encontrar o modo correspondente neste monitor
            mode = self._find_mode_by_params(
                monitor,
                common_mode['width'],
                common_mode['height'],
                common_mode['refresh']
            )
            if not mode:
                raise Exception(f"Monitor {monitor[0][0]} não suporta o modo selecionado")
                
            physical_configs.append([
                monitor[0][0],  # Nome do conector
                mode[0],        # ID do modo específico
                {}              # Propriedades
            ])

        logical_monitors = [(
            0, 0, 1.0, 0, True, physical_configs
        )]

        try:
            self._apply_config(logical_monitors)
            print("Modo espelhado ativado com sucesso")
        except dbus.exceptions.DBusException as e:
            print(f"Falha crítica: {e.get_dbus_message()}")

    def _find_common_mode(self, monitors):
        """Encontra modos com mesma resolução e taxa similar (±1Hz)"""
        mode_pool = {}
        TOLERANCE = 1.0  # 1Hz de tolerância
        
        for monitor in monitors:
            for mode in monitor[1]:
                key = (mode[1], mode[2])  # (width, height)
                refresh = mode[4]
                
                if key not in mode_pool:
                    mode_pool[key] = []
                mode_pool[key].append({
                    'refresh': refresh,
                    'monitors': {monitor[0][0]: mode[0]}}
                )

        # Procurar melhor resolução com taxas compatíveis
        for res in sorted(mode_pool.keys(), 
                        key=lambda x: x[0]*x[1], 
                        reverse=True):  # Maior resolução primeiro
            
            # Agrupar taxas similares
            refresh_groups = {}
            for entry in mode_pool[res]:
                rounded = round(entry['refresh'])
                if rounded not in refresh_groups:
                    refresh_groups[rounded] = []
                refresh_groups[rounded].append(entry)
            
            # Verificar grupos com taxas similares
            for group in refresh_groups.values():
                if len(group) >= len(monitors):
                    # Coletar modos de todos monitores
                    compatible = True
                    mode_ids = {}
                    for entry in group:
                        mode_ids.update(entry['monitors'])
                    
                    # Verificar se todos monitores tem este modo
                    for monitor in monitors:
                        if monitor[0][0] not in mode_ids:
                            compatible = False
                            break
                    if compatible:
                        return {
                            'width': res[0],
                            'height': res[1],
                            'refresh': group[0]['refresh']
                        }
        return None

    def _find_mode_by_params(self, monitor, width, height, refresh):
        """Encontra o modo mais próximo para um monitor específico"""
        TOLERANCE = 0.1
        for mode in monitor[1]:
            if (mode[1] == width and 
                mode[2] == height and 
                abs(mode[4] - refresh) <= TOLERANCE):
                return mode
        return None
################################
    def set_join(self):
        config = []
        x_offset = 0
        primary_set = False

        # Ordenar monitores: integrado primeiro depois externos
        display_order = [self.builtin] + self.externals if self.builtin else self.externals
        
        for monitor in display_order:
            if not monitor:
                continue
                
            mode = self._get_best_mode(monitor)
            config.append(self._create_monitor_config(
                monitor, mode, x_offset, 0, 
                primary=(not primary_set)
            ))
            x_offset += mode[1]  # Posicionar próximo monitor à direita
            primary_set = True

        if not config:
            raise Exception("Nenhum monitor detectado")
            
        self._apply_config(config)
        print("Modo estendido ativado")

    def _create_monitor_config(self, monitor, mode, x, y, primary=False):
        return (
            x, y,  # Posição
            1.0,   # Scale
            0,     # Rotação (normal)
            primary,
            [[monitor[0][0], mode[0], {}]]  # (connector, mode_id, properties)
        )

    def _find_common_resolution(self, monitors):
        resolutions = {}
        for monitor in monitors:
            for mode in monitor[1]:
                res = (mode[1], mode[2])  # (width, height)
                resolutions[res] = resolutions.get(res, 0) + 1

        # Buscar resolução suportada por todos monitores
        for res, count in sorted(
            resolutions.items(), 
            key=lambda x: (x[0][0] * x[0][1], x[0][0]), 
            reverse=True
        ):
            if count == len(monitors):
                return res
        return (1920, 1080)  # Fallback

    def _find_compatible_mode(self, monitor, target_res):
        for mode in monitor[1]:
            if mode[1] == target_res[0] and mode[2] == target_res[1]:
                return mode
        return self._get_best_mode(monitor)

def main():
    parser = argparse.ArgumentParser(
        description='Gerenciador de Configurações de Tela',
        epilog='Exemplos:\n  displayctl.py join\n  displayctl.py mirror',
        formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument('mode', 
        choices=['internal', 'external', 'mirror', 'join'],
        help='''Modos disponíveis:
  internal  - Somente tela integrada
  external  - Somente monitor externo
  mirror    - Espelhamento em todos monitores
  join      - Modo estendido (monitores lado a lado)'''
    )
    
    args = parser.parse_args()
    
    try:
        dm = DisplayManager()
        
        match args.mode:
            case 'internal': dm.set_internal()
            case 'external': dm.set_external()
            case 'mirror': dm.set_mirror()
            case 'join': dm.set_join()
                
    except Exception as e:
        print(f" Erro: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    main()