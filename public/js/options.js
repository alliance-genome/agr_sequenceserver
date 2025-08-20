import React, { Component } from 'react';

export class Options extends Component {
    constructor(props) {
        super(props);

        this.state = {
            textValue: '',
            objectValue: this.defaultObjectValue(),
            paramsMode: 'advanced'
        };

        this.onTextValueChanged = this.onTextValueChanged.bind(this);
        this.optionsPresetsJSX = this.optionsPresetsJSX.bind(this);
        this.advancedParamsJSX = this.advancedParamsJSX.bind(this);
        this.showAdvancedOptionsHelp = this.showAdvancedOptionsHelp.bind(this);
    }

    defaultObjectValue() {
        return {
            max_target_seqs: '',
            evalue: '',
            task: ''
        };
    }

    componentDidUpdate(prevProps) {
        if (prevProps.predefinedOptions !== this.props.predefinedOptions) {
            // Determine which set of options to use
            let selectedOptions = this.props.predefinedOptions.default || {attributes: []};
            
            // Check if there's a 'short-seq' option and use it if available
            if (this.props.predefinedOptions['short-seq']) {
                selectedOptions = this.props.predefinedOptions['short-seq'];
            }
    
            let initialTextValue = selectedOptions.attributes.join(' ').trim();
            let parsedOptions = this.parsedOptions(initialTextValue);
            
            this.setState({ 
                textValue: initialTextValue, 
                objectValue: parsedOptions 
            });
        }
    }

    onTextValueChanged(textValue) {
        let parsedOptions = this.parsedOptions(textValue.toString());

        this.setState({
            textValue: textValue.toString(),
            objectValue: parsedOptions
        });
    }

    parsedOptions(textValue) {
        const words = textValue.split(" ");
        let parsedOptions = this.defaultObjectValue();
        // Iterate through the words in steps of 2, treating each pair as an option and its potential value
        for (let i = 0; i < words.length; i += 2) {
            // Ensure there is a pair available
            if (words[i]) {
                if (words[i].startsWith("-")) {
                    const optionName = words[i].substring(1).trim();

                    if (words[i + 1]) {
                        // Use the second word as the value for this option
                        parsedOptions[optionName] = words[i + 1];
                    } else {
                        // No value found for this option, set it to null or a default value
                        parsedOptions[optionName] = null;
                    }
                }
            }
        }

        return parsedOptions;
    }

    optionsPresetsJSX() {
        return (
            <div id="options-presets" className="w-full">
                { Object.keys(this.props.predefinedOptions).length > 1 && <>
                    <div className="flex items-center border-b border-seqorange mb-2">
                        <h3 className="text-base md:text-lg font-medium pr-1">Settings</h3>
                        <p className="text-base text-gray-500">Choose a predefined setting or customize parameters.</p>
                    </div>
                    {this.presetListJSX()}
                </>}
            </div>
        );
    }

    presetListJSX() {
        return (
            <ul className="md:text-lg my-1">
                {
                    Object.entries(this.props.predefinedOptions).map(
                        ([key, config], index) => {
                            let textValue = config.attributes.join(' ').trim();
                            let description = config.description || textValue;

                            return (
                                <label key={index} className={`block w-full px-2 py-1 text-seqblue hover:bg-gray-200 hover:text-seqorange cursor-pointer`}>
                                    <input
                                        type="radio"
                                        name="predefinedOption"
                                        value={textValue}
                                        checked={textValue === this.state.textValue}
                                        onChange={() => this.onTextValueChanged(textValue)}
                                    />
                                    <strong className="ml-2">{key}:</strong>&nbsp;{description}
                                </label>
                            );
                        }
                    )
                }
            </ul>
        )
    }

    advancedParamsJSX() {
        return (
            <div className={this.state.paramsMode !== 'advanced' ? 'w-full hidden' : 'w-full'}>
                <div className="flex flex-wrap gap-4">
                    {/* E-value Dropdown */}
                    <div className="flex flex-col">
                        <label htmlFor="evalue" className="text-base md:text-lg">E-value:</label>
                        <select 
                            id="evalue" 
                            name="evalue" 
                            className="px-2 py-1 border rounded"
                            value={this.state.objectValue.evalue}
                            onChange={(e) => {
                                const newObjectValue = {...this.state.objectValue, evalue: e.target.value};
                                this.setState({
                                    objectValue: newObjectValue,
                                    textValue: Object.entries(newObjectValue)
                                        .filter(([k, v]) => v)
                                        .map(([k, v]) => `-${k} ${v}`)
                                        .join(' ')
                                });
                            }}
                        >
                            <option value="">Select E-value</option>
                            <option value="1e-32">1E-32</option>
                            <option value="1e-16">1E-16</option>
                            <option value="1e-8">1E-8</option>
                            <option value="1e-4">1E-4</option>
                            <option value="1e-2">1E-2</option>
                            <option value="1e+0">1E+0</option>
                            <option value="1e+1">1E+1</option>
                            <option value="1e+2">1E+2</option>
                            <option value="1e+4">1E+4</option>
                        </select>
                    </div>
    
                    {/* Max Target Sequences Dropdown */}
                    <div className="flex flex-col">
                        <label htmlFor="max_target_seqs" className="text-base md:text-lg">Max Hits:</label>
                        <select 
                            id="max_target_seqs" 
                            name="max_target_seqs" 
                            className="px-2 py-1 border rounded"
                            value={this.state.objectValue.max_target_seqs}
                            onChange={(e) => {
                                const newObjectValue = {...this.state.objectValue, max_target_seqs: e.target.value};
                                this.setState({
                                    objectValue: newObjectValue,
                                    textValue: Object.entries(newObjectValue)
                                        .filter(([k, v]) => v)
                                        .map(([k, v]) => `-${k} ${v}`)
                                        .join(' ')
                                });
                            }}
                        >
                            <option value="">Select Max Hits</option>
                            <option value="10">10</option>
                            <option value="50">50</option>
                            <option value="100">100</option>
                            <option value="250">250</option>
                        </select>
                    </div>
    
                    {/* BLAST Task Dropdown (if available) */}
                    {this.props.blastTasks && this.props.blastTasks.length > 0 && (
                        <div className="flex flex-col">
                            <label htmlFor="task" className="text-base md:text-lg">Task:</label>
                            <select 
                                id="task" 
                                name="task" 
                                className="px-2 py-1 border rounded"
                                value={this.state.objectValue.task}
                                onChange={(e) => {
                                    const newObjectValue = {...this.state.objectValue, task: e.target.value};
                                    this.setState({
                                        objectValue: newObjectValue,
                                        textValue: Object.entries(newObjectValue)
                                            .filter(([k, v]) => v)
                                            .map(([k, v]) => `-${k} ${v}`)
                                            .join(' ')
                                    });
                                }}
                            >
                                <option value="">Select Task</option>
                                {this.props.blastTasks.map((task, index) => (
                                    <option key={index} value={task}>{task}</option>
                                ))}
                            </select>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    showAdvancedOptionsHelp(e) {
        const ids = ['blastn', 'tblastn', 'blastp', 'blastx', 'tblastx'];
        const method = this.props.blastMethod.toLowerCase();
        const modal = document.querySelector("dialog.advanced-modal");

        // hide options for other algorithms and only show for selected algorithm
        for (const id of ids) {
            if (id === method) {
                document.getElementById(id).classList.remove('hidden');
            } else {
                document.getElementById(id).classList.add('hidden');
            }
        }

        modal.showModal();
    }

    render() {
        return (
            <div className="flex-grow flex flex-col items-start sm:items-center space-y-4">
                {this.optionsPresetsJSX()}

                {this.advancedParamsJSX()}

                {/* Hidden input fields to include options in form submission */}
                <input 
                    type="hidden" 
                    name="blast_params" 
                    value={this.state.textValue} 
                />
                {Object.entries(this.state.objectValue).map(([key, value]) => (
                    value && (
                        <input 
                            key={key} 
                            type="hidden" 
                            name={key} 
                            value={value} 
                        />
                    )
                ))}
            </div>
        );
    }
}
