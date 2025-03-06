import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Gettext from 'gettext';

const REF_HIGH_RES = { width: 1920, height: 1200, marginTop: 150, iconSize: 55, fontSize: 30 };
const REF_LOW_RES  = { width: 864,  height: 486,  marginTop: 50,  iconSize: 25, fontSize: 15 };
    
class FileMonitor {
    constructor(callback) {
        this._fileMonitor = null;
        this._callback = callback;
    }

    monitorFile(filePath) {
        const file = Gio.File.new_for_path(filePath);
        
        // Verifica se o arquivo existe antes de monitorar
        if (!file.query_exists(null)) {
            log(`[Monitor] Arquivo não encontrado: ${filePath}`);
            return;
        }

        this._fileMonitor = file.monitor(Gio.FileMonitorFlags.NONE, null);
        this._fileMonitor.connect('changed', (monitor, file, otherFile, eventType) => {
            if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
                log(`[Monitor] Alteração detectada em: ${file.get_path()}`);
                this._callback(); // Chama a função de callback
            }
        });
    }

    destroy() {
        if (this._fileMonitor) {
            this._fileMonitor.cancel();
            this._fileMonitor = null;
        }
    }
}

export default class DisplaySwitcher extends Extension {
    constructor(metadata) {
        super(metadata);
        this._keybindingId = 'shortcut-hdmidisplay';
        this._autoApplyTimeout = null;
        this._lastSelectedMode = null;
        this._inactivityTimeout = null; 
        this._fileMonitor = null;
    }

    enable() {
	    this._gettextDomain = 'monitordisplay'; // Nome do domínio
        Gettext.bindtextdomain(this._gettextDomain, this.path + '/locale');
        Gettext.textdomain(this._gettextDomain);
        this._firstExecution = true;
        this._settings = this.getSettings();
        
        Main.wm.addKeybinding(
            this._keybindingId,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            () => {
                if (this._hdmiWindow) {
                    this._cycleDisplayMode();
                } else {
                    this._checkHdmiConnection();
                }
            }
        );
        // Monitoramento de arquivo
        this._fileMonitor = new FileMonitor(() => {
            if (!Main.screenShield.locked) {
                this._checkHdmiConnection();
            } else {
                log("[Monitor] Ignorando evento - tela bloqueada");
            }
        });
        
        try {
            this._fileMonitor.monitorFile("/opt/hdmi-events");
        } catch (e) {
            log(`Erro no monitoramento: ${e.message}`);
        }        

    }

    disable() {
        if (this._interval) {
            GLib.source_remove(this._interval);
            this._interval = null;
        }
        this._removeHdmiMenu();
        this._removeHdmiWindow();
        Main.wm.removeKeybinding(this._keybindingId);
        this._settings = null;
        if (this._fileMonitor) {
            this._fileMonitor.destroy();
            this._fileMonitor = null;
        }
    }

    _runCommand() {
        const drmPath = '/sys/class/drm/';
        const drmDir = Gio.File.new_for_path(drmPath);

        try {
            const enumerator = drmDir.enumerate_children(
                'standard::name,standard::type', 
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let hdmiConnected = false;
            let dpConnected = false;

            let fileInfo;
            while ((fileInfo = enumerator.next_file(null))) {
                const fileName = fileInfo.get_name();
                const fileType = fileInfo.get_file_type();

                if (fileType !== Gio.FileType.DIRECTORY || 
                    !(fileName.includes('HDMI') || fileName.startsWith('DP'))) {
                    continue;
                }

                const statusFilePath = `${drmPath}${fileName}/status`;
                const statusFile = Gio.File.new_for_path(statusFilePath);

                if (!statusFile.query_exists(null)) {
                    log(`Arquivo não encontrado: ${statusFilePath}`);
                    continue;
                }

                const [success, contents] = statusFile.load_contents(null);
                if (!success) continue;

                const status = new TextDecoder().decode(contents).trim();
                log(`Conector: ${fileName}, Status: ${status}`);

                if (fileName.includes('HDMI') && status === 'connected') {
                    hdmiConnected = true;
                } else if (fileName.includes('DP') && status === 'connected') {
                    dpConnected = true;
                }
            }
            
            return hdmiConnected || dpConnected;
        } catch (e) {
            log(`Erro: ${e.message}`);
            return false;
        }
   }

    _notify(msg, details, icon) {
        Main.notify(msg, details, icon);
    }

    _checkHdmiConnection() {
        let connect = this._runCommand();
        if (connect) {
         //   this._showIconHdmiMenu();  
            this._showHdmiWindow();
        } else {
            this._removeHdmiMenu();
            this._removeHdmiWindow();
            log("HDMI não conectado");
            this._notify(_("HDMI not connected."), _("You must have HDMI connected."), 'dialog-information');
            this._firstExecution = true;
        }
    }

    _showIconHdmiMenu() {
        if (this._hdmiMenu) return;
        
        this._hdmiMenu = new PanelMenu.Button(0.0, _("HDMI Display Mode"));
        let icon = new St.Icon({ 
            icon_name: 'video-display-symbolic', 
            style_class: 'system-status-icon' 
        });
        this._hdmiMenu.add_child(icon);

        let internalOnly = new PopupMenu.PopupMenuItem(_("Internal only"));
        let externalOnly = new PopupMenu.PopupMenuItem(_("External only"));
        let joinDisplay = new PopupMenu.PopupMenuItem(_("Extended"));
        let mirrorDisplay = new PopupMenu.PopupMenuItem(_("Mirror"));

        const connectAction = (item, mode) => {
            item.connect('activate', () => {
                if (this._autoApplyTimeout) {
                    GLib.source_remove(this._autoApplyTimeout);
                    this._autoApplyTimeout = null;
                }
                this._setDisplayMode(mode);
                this._hdmiMenu.menu.close();
            });
        };

        connectAction(internalOnly, 'internal');
        connectAction(externalOnly, 'external');
        connectAction(joinDisplay, 'join');
        connectAction(mirrorDisplay, 'mirror');

        this._hdmiMenu.menu.addMenuItem(internalOnly);
        this._hdmiMenu.menu.addMenuItem(externalOnly);
        this._hdmiMenu.menu.addMenuItem(joinDisplay);
        this._hdmiMenu.menu.addMenuItem(mirrorDisplay);
 
        Main.panel.addToStatusArea("hdmiDisplayMenu", this._hdmiMenu);
    }

    _removeHdmiMenu() {
        if (this._hdmiMenu) {
            this._hdmiMenu.destroy();
            this._hdmiMenu = null;
        }
    }

    _showHdmiWindow() {
        if (this._hdmiWindow || !this._firstExecution) return;
  
        const monitor = Main.layoutManager.primaryMonitor;
        log(`Monitor width: ${monitor.width}, height: ${monitor.height}`);
        
        const { marginTop, iconSize, fontSize } = this._getScaledValue(monitor.height);
        //let x = monitor.width - (monitor.width * 0.26); // 30% da largura do monitor
        let x2 = monitor.width - 500; // 30% da largura do monitor
        // Criação da janela
        this._hdmiWindow = new St.BoxLayout({
            x: x2, // 30% da largura do monitor
            width: 500,
            height: monitor.height,
            vertical: true,
            style_class: 'hdmi-panel'
        });
        // Resetar timeout quando a janela receber foco
        this._hdmiWindow.connect('notify::mapped', () => {
            if (this._hdmiWindow.mapped) {
                this._resetInactivityTimeout();
            }
        });        
        

        // Título da janela
        let title = new St.Label({ 
            text: _("HDMI Display Mode"), 
            style_class: 'hdmi-title' 
        });
        this._hdmiWindow.add_child(title);
    
        // Função para criar botões
        const createButtonWithIcon = (iconName, labelText, mode, marginTop, FontSize, buttonHeight = 'auto') => {
            let icon = new St.Icon({
                icon_name: iconName,
                width: 100,
                style_class: 'hdmi-button-icon',
            });
            let label = new St.Label({ text: labelText });
            let box = new St.BoxLayout({ vertical: false });
            box.add_child(icon);
            box.add_child(label);
    
            // Criação do botão
            let button = new St.Button({
                style_class: 'hdmi-button',
                child: box,
                reactive: true,  // Habilita interatividade
                can_focus: true,  // Permite receber foco
            });
    
            // Efeito hover
            button.connect('enter-event', () => {
                this._resetInactivityTimeout();
                this._resetActiveButton();
                button.add_style_class_name('hdmi-button-active');
                this._hdmiWindow.grab_key_focus();
                // Cancelar o timeout automático se o mouse entrar no botão
                if (this._autoApplyTimeout) {
                    GLib.source_remove(this._autoApplyTimeout);
                    this._autoApplyTimeout = null;
                    log("[AUTO] Seleção via tecla cancelado devido à interação do mouse");
                }
            });
    
            // Evento de clique
            button.connect('clicked', () => {
                log(`Botão clicado: ${mode}`);
                if (this._autoApplyTimeout) {
                    GLib.source_remove(this._autoApplyTimeout);
                    this._autoApplyTimeout = null;
                }
                this._setDisplayMode(mode);
                this._removeHdmiWindow();  // Fecha a janela após o clique
            });
            button.set_style(`margin-top: ${marginTop}; font-size: ${FontSize}; height: ${buttonHeight};`);
            return button;
        };
    
        // Função para resetar o botão ativo
        this._resetActiveButton = () => {
            this._hdmiWindow.get_children().forEach(child => {
                if (child instanceof St.Button && child.has_style_class_name('hdmi-button-active')) {
                    child.remove_style_class_name('hdmi-button-active');
                    this._resetInactivityTimeout();
                }
            });
        };
    
        let px_icon = iconSize; 
        let px_font = fontSize; 
        // Criação dos botões
        let internalOnly = createButtonWithIcon('video-single-display-symbolic', _("Internal only"), 'internal',marginTop, px_font, px_icon);
        let externalOnly = createButtonWithIcon('computer-symbolic', _("External only"), 'external',marginTop, px_font, px_icon);
        let joinDisplay = createButtonWithIcon('video-joined-displays-symbolic', _("Extended"), 'join',marginTop ,px_font,  px_icon);
        let mirrorDisplay = createButtonWithIcon('view-mirror-symbolic', _("Mirror"), 'mirror', marginTop,px_font, px_icon);
    
        // Adiciona os botões à janela
        this._hdmiWindow.add_child(internalOnly);
        this._hdmiWindow.add_child(externalOnly);
        this._hdmiWindow.add_child(joinDisplay);
        this._hdmiWindow.add_child(mirrorDisplay);
    
        // Adiciona a janela ao grupo de UI
        Main.uiGroup.add_child(this._hdmiWindow);

        this._firstExecution = false;
    }

    _resetInactivityTimeout() {
        // Limpar timeout existente
        if (this._inactivityTimeout) {
            GLib.source_remove(this._inactivityTimeout);
            this._inactivityTimeout = null;
        }
        
        // Configurar novo timeout
        this._inactivityTimeout = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            5,
            () => {
                this._removeHdmiWindow();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _removeHdmiWindow() {
        // Limpar timeout de inatividade
        if (this._inactivityTimeout) {
            GLib.source_remove(this._inactivityTimeout);
            this._inactivityTimeout = null;
        }        
        if (this._autoApplyTimeout) {
            GLib.source_remove(this._autoApplyTimeout);
            this._autoApplyTimeout = null;
        }
        
        if (this._hdmiWindow) {
            this._hdmiWindow.destroy();
            this._hdmiWindow = null;
        }
        
        if (this._clickOutsideHandler) {
            global.stage.disconnect(this._clickOutsideHandler);
            this._clickOutsideHandler = null;
        }

        this._firstExecution = true;
    }

    _setDisplayMode(mode) {
        
        const scriptPathSwitch = this.path + '/scripts/hdmi-swicth-python.py';

        switch (mode) {
            case 'internal':
                log("Applying internal display mode...");
                GLib.spawn_command_line_async(`python3 ${scriptPathSwitch} internal`);
                break;
            case 'external':
                log("Applying external display mode...");
                GLib.spawn_command_line_async(`python3 ${scriptPathSwitch} external`);
                break;
            case 'join':
                log("Applying join display mode...");
                GLib.spawn_command_line_async(`python3 ${scriptPathSwitch} join`);
                break;
            case 'mirror':
                log("Applying mirror display mode...");
                GLib.spawn_command_line_async(`python3 ${scriptPathSwitch} mirror`);
                break;
            default:
                log(`Unknown display mode: ${mode}`);
                return;
        }

        log(`Display mode set to: ${mode}`);
        this._removeHdmiWindow();
    }

    _cycleDisplayMode() {
        if (!this._hdmiWindow) return;

        if (this._autoApplyTimeout) {
            GLib.source_remove(this._autoApplyTimeout);
            this._autoApplyTimeout = null;
        }

        const modes = ['internal', 'external', 'join', 'mirror'];
        this._currentModeIndex = ((this._currentModeIndex || 0) + 1) % modes.length;
        const selectedMode = modes[this._currentModeIndex];

        const buttons = this._hdmiWindow.get_children()
            .filter(c => c instanceof St.Button);
            
        if (buttons[this._currentModeIndex]) {
            this._resetActiveButton();
            buttons[this._currentModeIndex].add_style_class_name('hdmi-button-active');
            this._lastSelectedMode = selectedMode;
            
            this._autoApplyTimeout = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                2,
                () => {
                    if (this._hdmiWindow && this._lastSelectedMode === selectedMode) {
                        log(`[AUTO] Modo ${selectedMode} aplicado automaticamente`);
                        this._setDisplayMode(selectedMode);
                    }
                    this._autoApplyTimeout = null;
                    return GLib.SOURCE_REMOVE;
                }
            );

        }
    }
    // Função para calcular valores proporcionais
    _getScaledValue(currentHeight) {
        const clampedHeight = Math.min(Math.max(currentHeight, 486), 1200);
        const scale = (clampedHeight - 486) / (1200 - 486); //486  é a altura mínima de referência
        
        return {
            marginTop: `${Math.round(50 + (150 - 50) * scale)}px`, // 50px → 150px
            iconSize:  `${Math.round(25 + (55 - 25) * scale)}px`,          // 25 → 55
            fontSize:  `${Math.round(15 + (30 - 15) * scale)}px`    // 15px → 30px
        };
    }

}