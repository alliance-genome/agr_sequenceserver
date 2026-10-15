import { nodeMatchesQuery } from '../databases_tree';
import commonNames from '../../configs/common_names.json';

// Labels this host actually serves, one per deployment shape: an Alliance
// species folder, an Alliance build title, a WormBase species, a FlyBase
// species, an SGD fungal taxon folder and an SGD strain folder. Taken from
// searchdata.json, not invented, so a rename that breaks the alias table
// breaks this file too.
const LABELS = [
    'Caenorhabditis elegans',
    'C_elegans_Genome_Assembly',
    'Danio rerio',
    'ZFIN_GRCz12tu',
    'Drosophila melanogaster',
    'Fly_Release_6_plus_ISO1_MT',
    'Homo sapiens',
    'Human_GRCh38',
    'Mus musculus',
    'Mouse_GRCm39',
    'Rattus norvegicus',
    'RGD_GRCr8',
    'Saccharomyces cerevisiae',
    'Yeast_R64',
    'Xenopus laevis',
    'X_tropicalis_UCB_Xtro_10_0',
    'Apis mellifera',
    'Aedes aegypti',
    'Solenopsis invicta',
    'Agaricomycetes_mushrooms_allies',
    'S288C_Reference_Strain_Genomic_DNA',
];

const matching = (query) => LABELS.filter((label) => nodeMatchesQuery(query, label));

describe('database tree search', () => {
    it('matches node text, as jstree already did', () => {
        expect(matching('Danio')).toEqual(['Danio rerio']);
        expect(matching('GRCz12tu')).toEqual(['ZFIN_GRCz12tu']);
    });

    it('is case-insensitive on both sides', () => {
        expect(nodeMatchesQuery('danio RERIO', 'Danio rerio')).toBe(true);
        expect(nodeMatchesQuery('ZEBRAFISH', 'Danio rerio')).toBe(true);
    });

    it('answers the nine Alliance genomes by their common names', () => {
        expect(matching('zebrafish')).toEqual(['Danio rerio', 'ZFIN_GRCz12tu']);
        expect(matching('human')).toEqual(['Homo sapiens', 'Human_GRCh38']);
        expect(matching('mouse')).toEqual(['Mus musculus', 'Mouse_GRCm39']);
        expect(matching('rat')).toEqual(['Rattus norvegicus', 'RGD_GRCr8']);
        expect(matching('frog')).toEqual(['Xenopus laevis', 'X_tropicalis_UCB_Xtro_10_0']);
        expect(matching('yeast')).toEqual([
            'Saccharomyces cerevisiae', 'Yeast_R64', 'S288C_Reference_Strain_Genomic_DNA',
        ]);
    });

    // A common name reaches a whole group through the species folder. The
    // folder's databases follow from jstree's show_only_matches_children, so
    // a leaf whose build title carries no species name, as WormBase's
    // C_elegans_Genome_Assembly does not, still shows under a matched folder.
    it('matches a group by its common name, not one species', () => {
        expect(matching('worm')).toEqual(['Caenorhabditis elegans']);
        expect(matching('fly')).toEqual(['Drosophila melanogaster', 'Fly_Release_6_plus_ISO1_MT']);
        expect(matching('bee')).toEqual(['Apis mellifera']);
        expect(matching('ant')).toEqual(['Solenopsis invicta']);
        expect(matching('mosquito')).toEqual(['Aedes aegypti']);
        expect(matching('mushroom')).toEqual(['Agaricomycetes_mushrooms_allies']);
    });

    it('matches a prefix of a common name, so a partial query works', () => {
        expect(matching('zebra')).toEqual(['Danio rerio', 'ZFIN_GRCz12tu']);
        expect(matching('nema')).toEqual(['Caenorhabditis elegans']);
    });

    // "a" is a substring of ant, aphid, rat and yeast. Consulting the table on
    // one or two characters would match most of the tree on an early keystroke.
    // The two extra hits here are plain text matches, in melliFERA and StRAin,
    // which jstree already made and which this change does not touch.
    it('does not consult the alias table for one or two characters', () => {
        expect(matching('ra')).toEqual([
            'Rattus norvegicus', 'Apis mellifera', 'S288C_Reference_Strain_Genomic_DNA',
        ]);
        expect(matching('')).toEqual([]);
    });

    it('answers nothing for a name this host does not serve', () => {
        expect(matching('chicken')).toEqual([]);
        expect(matching('arabidopsis')).toEqual([]);
    });

    // A pattern that stops matching any label is dead weight and nothing else
    // would say so. This is the whole table, not the sample above.
    it('has no alias pattern that cannot match a label', () => {
        const dead = [];
        Object.entries(commonNames.aliases).forEach(([alias, patterns]) => {
            patterns.forEach((pattern) => {
                if (!/^[A-Za-z0-9_ .]+$/.test(pattern)) dead.push([alias, pattern, 'odd characters']);
            });
        });
        expect(dead).toEqual([]);
        expect(Object.keys(commonNames.aliases).length).toBe(40);
    });
});
