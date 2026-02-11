import {
	App,
	DropdownComponent,
	Modal,
	Notice,
	Setting,
	TFile,
} from "obsidian";
import { getDefFileManager, DEF_CTX_FM_KEY } from "src/core/def-file-manager";
import { DefFileUpdater } from "src/core/def-file-updater";
import { DefFileType } from "src/core/file-type";

export class AddDefinitionModal {
	app: App;
	activeFile: TFile | null;
	modal: Modal;
	aliases: string;
	definition: string;
	submitting: boolean;

	fileTypePicker: DropdownComponent;
	defFilePickerSetting: Setting;
	defFilePicker: DropdownComponent;

	atomicFolderPickerSetting: Setting;
	atomicFolderPicker: DropdownComponent;

	constructor(app: App) {
		this.app = app;
		this.modal = new Modal(app);
	}

	open(text?: string) {
		// initialize the view when the modal is opened to ensure it's up to date
		this.activeFile = this.app.workspace.getActiveFile();

		this.submitting = false;

		// create modal content
		this.modal.setTitle("Add Definition");
		this.modal.contentEl.createDiv({
			cls: "edit-modal-section-header",
			text: "Word/Phrase",
		});
		const phraseText = this.modal.contentEl.createEl("textarea", {
			cls: "edit-modal-aliases",
			attr: {
				placeholder: "Word/phrase to be defined",
			},
			text: text ?? "",
		});
		this.modal.contentEl.createDiv({
			cls: "edit-modal-section-header",
			text: "Aliases",
		});
		const aliasText = this.modal.contentEl.createEl("textarea", {
			cls: "edit-modal-aliases",
			attr: {
				placeholder: "Add comma-separated aliases here",
			},
		});
		this.modal.contentEl.createDiv({
			cls: "edit-modal-section-header",
			text: "Definition",
		});
		const defText = this.modal.contentEl.createEl("textarea", {
			cls: "edit-modal-textarea",
			attr: {
				placeholder: "Add definition here",
			},
		});

		// create definition file picker
		const defManager = getDefFileManager();

		// get the currently opened file's first folder and first file, if they exist
		let default_def_file = "";
		let default_def_folder = "";
		let paths: Array<string> = [];

		// if the currently open file has at least one definition context, use it's
		// first context as the initial value
		if (this.activeFile) {
			const metadataCache = this.app.metadataCache.getFileCache(
				this.activeFile,
			);
			paths = metadataCache?.frontmatter?.[DEF_CTX_FM_KEY];
			if (paths) {
				// get the first folder in the path (if it exists) - use regexp to remove the trailing
				// `/` that might be present
				default_def_folder =
					paths.find(
						(path: string) =>
							this.app.vault.getFolderByPath(
								path.replace(/\/+$/, ""),
							) != null,
					) || "";
				if (default_def_folder) {
					default_def_folder = default_def_folder.replace(/\/+$/, "");
				}

				// get the first file in the path (if it exists)
				default_def_file =
					paths.find(
						(path: string) =>
							this.app.vault.getFileByPath(path) != null,
					) || "";
			}
		}

		this.defFilePickerSetting = new Setting(this.modal.contentEl)
			.setName("Definition file")
			.addDropdown((component) => {
				const defFiles = defManager.getConsolidatedDefFiles();
				defFiles.forEach((file) => {
					component.addOption(file.path, file.path);
				});

				// use the first definition file from this file's metadata, or default to
				// the first folder in the list if it exists
				if (default_def_file) {
					component.setValue(default_def_file);
				} else if (defFiles.length > 0) {
					component.setValue(defFiles[0].path);
				}

				this.defFilePicker = component;
			});

		this.atomicFolderPickerSetting = new Setting(this.modal.contentEl)
			.setName("Add file to folder")
			.addDropdown((component) => {
				const defFolders = defManager.getDefFolders();
				defFolders.forEach((folder) => {
					component.addOption(folder.path, folder.path + "/");
				});

				// use the first definition folder from this file's metadata, or default to
				// the first folder in the list if it exists
				if (default_def_folder) {
					component.setValue(default_def_folder);
				} else if (defFolders.length > 0) {
					component.setValue(defFolders[0].path);
				}

				this.atomicFolderPicker = component;
			});

		new Setting(this.modal.contentEl)
			.setName("Definition file type")
			.addDropdown((component) => {
				const handleDefFileTypeChange = (val: string) => {
					if (val === DefFileType.Consolidated) {
						this.atomicFolderPickerSetting.settingEl.hide();
						this.defFilePickerSetting.settingEl.show();
					} else if (val === DefFileType.Atomic) {
						this.defFilePickerSetting.settingEl.hide();
						this.atomicFolderPickerSetting.settingEl.show();
					}
				};

				component.addOption(DefFileType.Consolidated, "Consolidated");
				component.addOption(DefFileType.Atomic, "Atomic");

				// use the default definition type as a fallback
				component.setValue(
					window.NoteDefinition.settings.defFileParseConfig
						.defaultFileType,
				);

				// attempt to automatically determine the definition type we should use if there
				// is at least one item in the definition context and the setting is enabled
				if (
					window.NoteDefinition.settings.defModalsConfig
						.automaticallyDetermineNewDefTypes &&
					paths
				) {
					// automatically determine the definition file type to default to based on
					// the first item in the definition context list
					if (paths[0] == default_def_file) {
						component.setValue("consolidated");
					} else if (paths[0] == default_def_folder + "/") {
						component.setValue("atomic");
					}
				}

				component.onChange(handleDefFileTypeChange);
				handleDefFileTypeChange(component.getValue());
				this.fileTypePicker = component;
			});

		const button = this.modal.contentEl.createEl("button", {
			text: "Save",
			cls: "edit-modal-save-button",
		});

		button.addEventListener("click", () => {
			this.try_submit(phraseText, defText, aliasText);
		});

		// set up key event listeners for closing and submitting the modal
		this.modal.scope.register(["Mod"], "Enter", () => {
			this.try_submit(phraseText, defText, aliasText);
		});

		this.modal.open();
	}

	// Checks if the requirements for a definition (name, description, file) have been met,
	// showing an error notification if they haven't. Creates the definition and closes the modal
	// if there aren't any issues.
	try_submit(
		phraseText: HTMLTextAreaElement,
		defText: HTMLTextAreaElement,
		aliasText: HTMLTextAreaElement,
	) {
		// we're already submitting the definition
		if (this.submitting) {
			return;
		}

		// invalid definition paramters (missing name or description)
		if (!phraseText.value || !defText.value) {
			new Notice("Please fill in a definition value");
			return;
		}

		const fileType = this.fileTypePicker.getValue();
		let selectedPath = "";
		let definitionFile;

		if (fileType === DefFileType.Consolidated) {
			selectedPath = this.defFilePicker.getValue();
			if (!selectedPath) {
				new Notice(
					"Please choose a definition file. If you do not have any definition files, please create one.",
				);
				return;
			}
			const defFileManager = getDefFileManager();
			definitionFile = defFileManager.globalDefFiles.get(selectedPath);
		} else if (fileType === DefFileType.Atomic) {
			selectedPath = this.atomicFolderPicker.getValue();
			if (!selectedPath) {
				new Notice("Please choose a folder for the atomic definition.");
				return;
			}
			definitionFile = undefined;
		} else {
			new Notice("Invalid file type selected.");
			return;
		}

		const updated = new DefFileUpdater(this.app);
		updated.addDefinition(
			{
				fileType: fileType as DefFileType,
				key: phraseText.value.toLowerCase(),
				word: phraseText.value,
				aliases: aliasText.value
					? aliasText.value.split(",").map((alias) => alias.trim())
					: [],
				definition: defText.value,
				file: definitionFile,
			},
			selectedPath,
		);
		this.modal.close();
	}
}
