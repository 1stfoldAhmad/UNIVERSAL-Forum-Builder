<?php
declare(strict_types=1);

namespace VdsForm\Renderer;

final class Capabilities
{
    public const SUPPORTED = [
        'text', 'textarea', 'email', 'password', 'url', 'phone', 'integer', 'decimal',
        'currency', 'percentage', 'duration', 'date', 'time', 'datetime', 'select',
        'multiselect', 'radio', 'checkbox', 'switch', 'consent', 'rating', 'range',
        'color', 'file', 'image', 'computed', 'hidden', 'group', 'repeater', 'barcode',
    ];

    public static function manifest(): array
    {
        $fieldTypes = [];
        foreach (self::SUPPORTED as $t) $fieldTypes[$t] = ['fieldType' => $t, 'supported' => true];
        return [
            'target' => 'laravel',
            'contractVersion' => '1.0.0',
            'fieldTypes' => $fieldTypes,
            'features' => [
                'dragDrop' => true, 'filePicker' => true, 'camera' => false, 'offlineQueue' => true,
                'draftPersistence' => true, 'multiStep' => true, 'repeaters' => true, 'richText' => false, 'signature' => false,
            ],
        ];
    }
}
